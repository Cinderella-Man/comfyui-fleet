"""Build a runtime-only archive. Does not connect to the rig or install anything."""

import hashlib
import gzip
import json
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parents[1]
destination = root / "dist"
destination.mkdir(exist_ok=True)
files = [
    root / name
    for name in (
        "__init__.py",
        "pyproject.toml",
        "fleet/__init__.py",
        "fleet/artifacts.py",
        "fleet/controller.py",
        "fleet/compatibility.py",
        "fleet/http.py",
        "fleet/jobs.py",
        "fleet/store.py",
        "fleet/snapshots.py",
        "fleet/validation.py",
        "fleet/worker.py",
        "web/fleet.js",
        "web/editing.js",
        "web/details.js",
        "web/panel.js",
        "web/preparation.js",
        "web/progress.js",
        "THIRD_PARTY_NOTICES.md",
        "LICENSE",
        "tools/restore.py",
        "docs/INSTALL.md",
        "docs/RECOVERY.md",
        "docs/USAGE.md",
    )
]
archive = destination / "ComfyUI-Fleet-0.2.0.tar.gz"
with (
    archive.open("wb") as stream,
    gzip.GzipFile(filename="", fileobj=stream, mode="wb", mtime=0) as compressed,
):
    with tarfile.open(fileobj=compressed, mode="w") as tar:
        for path in files:
            info = tar.gettarinfo(path, arcname="ComfyUI-Fleet/" + str(path.relative_to(root)))
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ""
            info.mode = 0o644
            with path.open("rb") as source:
                tar.addfile(info, source)
manifest = {
    "version": "0.2.0",
    "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    "files": {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
}
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(archive)
