"""Restore an ordered node configuration while the controller is stopped.

Existing jobs, submission identities and pause state remain in the live ledger.
Node backups contain no jobs, workflows, inputs or history to replay.
"""

import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fleet.artifacts import open_regular  # noqa: E402
from fleet.store import Ledger  # noqa: E402
from fleet.validation import workers_config  # noqa: E402

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("snapshot", type=Path, help="Node-only JSON backup")
parser.add_argument("state_directory", type=Path, help="Controller Fleet state directory")
args = parser.parse_args()

with os.fdopen(open_regular(args.snapshot.parent, args.snapshot.name), "rb") as stream:
    raw = stream.read(65537)
if len(raw) > 65536:
    raise SystemExit("Node configuration backup exceeds 64 KiB")
try:
    payload = json.loads(raw)
except (ValueError, UnicodeError):
    raise SystemExit(
        "Expected a node-only JSON backup; legacy job databases are not supported"
    ) from None
if (
    not isinstance(payload, dict)
    or set(payload) != {"format", "version", "nodes"}
    or payload["format"] != "comfyui-fleet-nodes"
    or type(payload["version"]) is not int
    or payload["version"] != 1
    or not isinstance(payload["nodes"], list)
    or any(
        not isinstance(node, dict) or set(node) != {"id", "url", "enabled"}
        for node in payload["nodes"]
    )
):
    raise SystemExit("Expected a version 1 node-only JSON backup")
nodes = workers_config(payload["nodes"])

# The ledger owns the process lock and applies configuration and order atomically.
# Its existing guards refuse to orphan active jobs or their collection retries.
store = Ledger(args.state_directory)
try:
    store.configure(nodes, restore_order=True)
finally:
    store.close()
print(f"Restored {len(nodes)} nodes in saved order. Existing jobs were preserved.")
