"""Snapshot standard inputs and publish collected outputs in Fleet-owned namespaces."""

import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import re
import uuid

from .store import owned_directory
from .validation import MAX_FILE, file_reference, identity


def open_regular(root, relative):
    """Walk beneath a configured root without following any symbolic links."""
    parts = Path(relative).parts
    if not parts or Path(relative).is_absolute() or any(x in (".", "..") for x in parts):
        raise ValueError("Invalid relative file path")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        result = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        if not stat.S_ISREG(os.fstat(result).st_mode):
            os.close(result)
            raise ValueError("Expected an ordinary file")
        return result
    finally:
        os.close(fd)


def read_regular(root, relative):
    with os.fdopen(open_regular(root, relative), "rb") as stream:
        data = stream.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise ValueError("File exceeds the 256 MiB transfer limit")
    return data


def publish(directory, name, data):
    """Atomic publication; refuse replacing a nonidentical existing artifact."""
    owned_directory(directory)
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = f".{uuid.uuid4()}.part"
    try:
        target = Path(directory) / name
        if target.exists() or target.is_symlink():
            if read_regular(directory, name) != data:
                raise ValueError("Existing artifact differs; refusing to overwrite it")
            return
        output = os.open(
            temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=fd
        )
        with os.fdopen(output, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # link is an atomic create-if-absent, unlike replace which overwrites.
        os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        os.unlink(temporary, dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.close(fd)


class Artifacts:
    def __init__(self, state_root, roots, *, output_layout="job"):
        if output_layout not in ("flat", "batch", "job"):
            raise ValueError("FLEET_OUTPUT_LAYOUT must be flat, batch or job")
        self.output_layout = output_layout
        self.blobs = owned_directory(Path(state_root) / "inputs")
        self.output = owned_directory(Path(roots["output"]) / "fleet")
        self.roots = roots
        instance = Path(state_root) / "instance-id"
        if not instance.exists():
            publish(state_root, "instance-id", str(uuid.uuid4()).encode())
        self.instance = identity(read_regular(state_root, "instance-id").decode())

    def snapshot(self, graph):
        assets = []
        for node_id, node in graph.items():
            if node["class_type"] not in ("LoadImage", "LoadImageMask"):
                continue
            value = node["inputs"].get("image")
            if not isinstance(value, str):
                raise ValueError(
                    "Linked/custom input filenames are not supported by standard input transfer"
                )
            kind = "input"
            for suffix in ("input", "output", "temp"):
                if value.endswith(f" [{suffix}]"):
                    value, kind = value[: -(len(suffix) + 3)], suffix
                    break
            path = Path(value)
            ref = file_reference(
                {
                    "filename": path.name,
                    "subfolder": str(path.parent) if str(path.parent) != "." else "",
                    "type": kind,
                }
            )
            data = read_regular(self.roots[kind], value)
            digest = hashlib.sha256(data).hexdigest()
            publish(self.blobs, digest, data)
            assets.append(
                {
                    "node_id": node_id,
                    "key": "image",
                    "sha256": digest,
                    "name": ref["filename"],
                    "source": ref,
                    "bytes": len(data),
                }
            )
            del data
        return assets

    def prune_inputs(self, keep):
        """Delete only unreferenced Fleet snapshots, never original inputs or results."""
        fd = os.open(self.blobs, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            changed = False
            for name in os.listdir(fd):
                if name in keep or not re.fullmatch(r"[0-9a-f]{64}|\.[0-9a-f-]{36}\.part", name):
                    continue
                mode = os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode
                if stat.S_ISREG(mode) or stat.S_ISLNK(mode):
                    os.unlink(name, dir_fd=fd)
                    changed = True
            if changed:
                os.fsync(fd)
        finally:
            os.close(fd)

    async def prepare(self, row, remote):
        graph = copy.deepcopy(row["graph"])
        for asset in row["assets"]:
            data = await asyncio.to_thread(read_regular, self.blobs, asset["sha256"])
            if hashlib.sha256(data).hexdigest() != asset["sha256"]:
                raise ValueError("Input snapshot failed its digest check")
            subfolder = f"fleet/{self.instance}/{asset['sha256']}"
            reply = await remote.upload(row["worker_url"], asset["name"], subfolder, data)
            del data
            ref = file_reference(
                {
                    "filename": reply["name"],
                    "subfolder": reply.get("subfolder", ""),
                    "type": reply.get("type", "input"),
                }
            )
            if ref["type"] != "input" or ref["subfolder"] != subfolder:
                raise ValueError("Worker returned an unexpected upload namespace")
            graph[asset["node_id"]]["inputs"][asset["key"]] = (
                f"{ref['subfolder']}/{ref['filename']} [input]"
            )
        return graph

    def collection_directory(self, row):
        """Reuse partial publications when a restart changes the configured layout."""
        job_id = identity(row["id"])
        choices = {"job": self.output / job_id, "flat": self.output}
        if row.get("batch_id"):
            choices["batch"] = self.output / ("batch-" + identity(row["batch_id"]))
        existing = []
        for layout, directory in choices.items():
            if directory.is_symlink():
                raise ValueError("Fleet storage must not contain symlinks")
            if directory.exists() and (layout == "job" or any(directory.glob(job_id + "-*"))):
                existing.append(layout)
        if len(existing) > 1:
            raise ValueError("Job outputs exist in multiple layouts; resolve before retrying")
        layout = existing[0] if existing else self.output_layout
        return layout, choices[layout]

    async def collect(self, row, remote):
        output = copy.deepcopy(row["history"].get("outputs", {}))
        layout, destination = await asyncio.to_thread(self.collection_directory, row)
        subfolder = destination.relative_to(self.roots["output"]).as_posix()
        counter = 0
        for node in output.values():
            if not isinstance(node, dict):
                continue
            for media, entries in node.items():
                if not isinstance(entries, list):
                    continue
                for index, ref in enumerate(entries):
                    if not isinstance(ref, dict) or "filename" not in ref:
                        continue
                    counter += 1
                    if counter > 8192:
                        raise ValueError("Output manifest exceeds 8192 reported files")
                    safe = file_reference(ref)
                    data = await remote.download(row["worker_url"], safe)
                    # Shared folders also need the job identity: every worker can
                    # independently report the same filename and counter.
                    prefix = (row["id"] + "-") if layout != "job" else ""
                    prefix += f"{counter:04d}-"
                    name = prefix + safe["filename"]
                    if len(name.encode()) > 240:
                        name = f"{prefix}{hashlib.sha256(data).hexdigest()}{Path(safe['filename']).suffix[:12]}"
                    await asyncio.to_thread(publish, destination, name, data)
                    del data
                    entries[index] = {
                        **ref,
                        "filename": name,
                        "subfolder": subfolder,
                        "type": "output",
                    }
        manifest = {"job_id": row["id"], "remote_id": row["remote_id"], "outputs": output}
        data = json.dumps(manifest, indent=2).encode()
        previous = None
        if layout == "job":
            try:
                previous = await asyncio.to_thread(read_regular, destination, "fleet-manifest.json")
            except FileNotFoundError:
                pass
        # A pre-upgrade collection may have published files before its ledger commit.
        # Keep its original manifest byte-for-byte when retrying that exact collection.
        legacy = {"run_id": row["id"], "remote_id": row["remote_id"], "outputs": output}
        if previous is not None and previous not in (data, json.dumps(legacy, indent=2).encode()):
            raise ValueError("Existing artifact differs; refusing to overwrite it")
        # New results need no extra history file: publication is already atomic and
        # collection retries retain their remote references in the ledger.
        return output
