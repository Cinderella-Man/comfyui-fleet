"""Expose Fleet jobs in ComfyUI's format, merging local jobs before pagination."""


def output_summary(outputs):
    refs = [
        {**ref, "nodeId": node, "mediaType": media}
        for node, value in outputs.items()
        if isinstance(value, dict)
        for media, items in value.items()
        if isinstance(items, list)
        for ref in items
        if isinstance(ref, dict) and "filename" in ref
    ]
    text = next(
        (
            {
                "content": value[:1024],
                **({"truncated": True} if len(value) > 1024 else {}),
                "nodeId": node,
                "mediaType": "text",
            }
            for node, output in outputs.items()
            if isinstance(output, dict) and isinstance(output.get("text"), list)
            for value in output["text"]
            if isinstance(value, str)
        ),
        None,
    )

    def priority(ref):
        if ref["mediaType"] == "text" or (
            ref["mediaType"] not in {"images", "video", "audio", "3d"}
            and ref["filename"].lower().endswith((".txt", ".md", ".json"))
        ):
            return 2
        return 0 if ref.get("type") == "output" else 1

    previews = [
        ref
        for ref in refs
        if ref["mediaType"] in {"images", "video", "audio", "3d", "text"}
        or str(ref.get("format", "")).startswith(("video/", "audio/"))
        or ref["filename"]
        .lower()
        .endswith((".obj", ".fbx", ".gltf", ".glb", ".usdz", ".txt", ".md", ".json"))
    ]
    return len(refs), len(previews), min(previews, key=priority, default=text)


def job(row, detail=False):
    outputs = row["outputs"] or {}
    count, previewable, preview = output_summary(outputs)
    state = row["state"]
    status = {
        "waiting": "pending",
        "preparing": "pending",
        "outstanding": "in_progress",
        "unknown": "in_progress",
        "succeeded": "completed",
        "failed": "failed",
        "cancelled": "cancelled",
    }[state]
    if state == "unknown" and not row["occupied"]:
        status = "failed"  # Native UI has no unknown status; Fleet retains the exact distinction.
    if state == "succeeded" and row["collection_state"] != "collected":
        status = {"error": "failed", "partial": "completed", "unavailable": "cancelled"}.get(
            row["collection_state"], "in_progress"
        )
    result = {
        "id": row["id"],
        "status": status,
        "priority": row["priority"],
        "create_time": round(row["created"] * 1000),
        "workflow_id": row["workflow"].get("id"),
        "execution_start_time": round(row["started"] * 1000) if row["started"] else None,
        "execution_end_time": round(row["ended"] * 1000) if row["ended"] else None,
        "outputs_count": count,
        "previewable_outputs_count": previewable,
        "preview_output": preview,
        "fleet": {
            "batch_id": row["batch_id"],
            "worker_id": row["worker_id"],
            "state": state,
            "collection_state": row["collection_state"],
            "error": row["error"],
            "diagnostics": row["diagnostics"],
            "collection_note": {
                "partial": "Some result files were unavailable. Available results were saved.",
                "unavailable": "Result files were unavailable. This job was closed automatically.",
            }.get(row["collection_state"]),
        },
    }
    if detail:
        result.update(
            outputs=outputs,
            workflow={
                "prompt": row["graph"],
                "extra_data": {"extra_pnginfo": {"workflow": row["workflow"]}},
            },
            execution_status=row["history"]["status"] if row["history"] else None,
        )
    return result


def merged_jobs(rows, local, query):
    owned = {r["remote_id"] for r in rows if r["remote_id"]}
    results = [job(r) for r in rows if not r["hidden"]] + [j for j in local if j["id"] not in owned]
    if query.get("status"):
        wanted = set(query["status"].split(","))
        if not wanted <= {"pending", "in_progress", "completed", "failed", "cancelled"}:
            raise ValueError("Invalid job status filter")
        results = [j for j in results if j["status"] in wanted]
    if query.get("workflow_id"):
        results = [j for j in results if j.get("workflow_id") == query["workflow_id"]]
    sort_by, order = query.get("sort_by", "created_at"), query.get("sort_order", "desc")
    if sort_by not in ("created_at", "execution_duration") or order not in ("asc", "desc"):
        raise ValueError("Invalid job sort")

    def key(item):
        if sort_by == "execution_duration":
            return (item.get("execution_end_time") or 0) - (item.get("execution_start_time") or 0)
        return item.get("create_time") or 0

    results.sort(key=key, reverse=order == "desc")
    offset, limit = max(0, int(query.get("offset", 0))), int(query.get("limit", 1000))
    if not 1 <= limit <= 10000:
        raise ValueError("Job page limit must be 1–10000")
    return {
        "jobs": results[offset : offset + limit],
        "pagination": {
            "offset": offset,
            "limit": limit,
            "total": len(results),
            "has_more": offset + limit < len(results),
        },
    }
