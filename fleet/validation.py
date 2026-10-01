"""Shared validation for identities, enrolled endpoints, and prepared batches."""

import hashlib
import ipaddress
import json
import re
import uuid
from urllib.parse import urlsplit

MAX_BODY = 32 * 1024 * 1024
MAX_FILE = 256 * 1024 * 1024
MAX_JOBS = 1000
TERMINAL = frozenset({"succeeded", "failed", "cancelled"})
PRIVATE_NETWORKS = tuple(
    map(
        ipaddress.ip_network,
        (
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "127.0.0.0/8",
            "100.64.0.0/10",
            "fc00::/7",
            "::1/128",
        ),
    )
)


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def identity(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Expected a canonical UUID")
    return value


def worker_url(value):
    if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value):
        raise ValueError("Expected an HTTP(S) URL with a private numeric IP address")
    u = urlsplit(value)
    address = ipaddress.ip_address(u.hostname or "")
    if (
        u.scheme not in ("http", "https")
        or u.username is not None
        or u.password is not None
        or u.query
        or u.fragment
        or u.path not in ("", "/")
        or not any(address in net for net in PRIVATE_NETWORKS)
        or address.is_unspecified
        or address.is_multicast
    ):
        raise ValueError("Worker must use a private IP, no credentials, path, query or fragment")
    host = f"[{address}]" if address.version == 6 else str(address)
    port = u.port or (443 if u.scheme == "https" else 80)
    return f"{u.scheme}://{host}:{port}"


def workers_config(values):
    if not isinstance(values, list) or len(values) > 64:
        raise ValueError("Expected at most 64 workers")
    result = []
    for value in values:
        key = value.get("id", "")
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key):
            raise ValueError("Worker ID must contain 1–64 letters, digits, underscores or hyphens")
        if not isinstance(value.get("enabled", True), bool):
            raise ValueError("Worker enabled must be a boolean")
        result.append(
            {"id": key, "url": worker_url(value["url"]), "enabled": value.get("enabled", True)}
        )
    if len({w["id"] for w in result}) != len(result) or len({w["url"] for w in result}) != len(
        result
    ):
        raise ValueError("Duplicate worker ID or endpoint")
    return result


def prepared_batch(body):
    # Accept an older prepared request, but use job terminology internally.
    if "runs" in body:
        if "jobs" in body:
            raise ValueError("Supply only one job list")
        body = {("jobs" if key == "runs" else key): value for key, value in body.items()}
    identity(body["batch_id"])
    jobs = body.get("jobs")
    if not isinstance(jobs, list) or not 1 <= len(jobs) <= MAX_JOBS:
        raise ValueError(f"Expected 1–{MAX_JOBS} complete workflow jobs")
    for job in jobs:
        graph = job.get("output")
        if not isinstance(graph, dict) or not graph or len(graph) > 4096:
            raise ValueError("Expected a nonempty execution graph with at most 4096 nodes")
        if not isinstance(job.get("workflow"), dict):
            raise ValueError("Saved workflow metadata is required")
        for node in graph.values():
            if (
                not isinstance(node, dict)
                or not isinstance(node.get("class_type"), str)
                or not isinstance(node.get("inputs"), dict)
            ):
                raise ValueError("Invalid execution node")
    if len(canonical(body).encode()) > MAX_BODY:
        raise ValueError("Prepared batch exceeds 32 MiB")
    return body


def batch_digests(body):
    """Match saved pre-rename admissions without admitting the same work twice."""
    legacy = {("runs" if key == "jobs" else key): value for key, value in body.items()}
    return tuple(hashlib.sha256(canonical(value).encode()).hexdigest() for value in (body, legacy))


def file_reference(ref):
    name, subfolder, kind = ref.get("filename"), ref.get("subfolder", ""), ref.get("type", "output")
    if (
        not isinstance(name, str)
        or name in ("", ".", "..")
        or "/" in name
        or "\\" in name
        or not isinstance(subfolder, str)
        or subfolder.startswith("/")
        or "\\" in subfolder
        or ".." in subfolder.split("/")
        or kind not in ("input", "output", "temp")
        or any(ord(c) < 32 for c in name + subfolder)
    ):
        raise ValueError("Unsafe artifact reference")
    return {"filename": name, "subfolder": subfolder, "type": kind}
