import json
import subprocess
import sys
from pathlib import Path

from fleet.store import Ledger
from test_ledger import batch
from test_upgrade import legacy_ledger


def restore(snapshot, root):
    return subprocess.run(
        [
            sys.executable,
            str(Path(__file__).parents[1] / "tools/restore.py"),
            str(snapshot),
            str(root),
        ],
        capture_output=True,
        text=True,
    )


def test_node_restore_preserves_order_enabled_states_and_existing_jobs(tmp_path):
    root = tmp_path / "state"
    store = Ledger(root)
    nodes = [
        {"id": "second", "url": "http://127.0.0.2:8188", "enabled": False},
        {"id": "first", "url": "http://127.0.0.1:8188", "enabled": True},
    ]
    store.configure(nodes)
    snapshot = root / "backups" / store.backup()["filename"]
    value = batch(2)
    accepted = store.admit(value, [[], []], [["first"], ["first"]])
    assigned = store.claim("first")
    store.begin_submit(assigned["id"])
    store.pause(True)
    jobs = store.jobs()
    try:
        live = restore(snapshot, root)
        assert live.returncode != 0 and "BlockingIOError" in live.stderr
        store.configure([{**node, "enabled": True} for node in nodes])
        store.reorder_worker("first", "second")
    finally:
        store.close()
    result = restore(snapshot, root)
    assert result.returncode == 0, result.stderr
    restored = Ledger(root)
    try:
        assert restored.workers() == nodes
        assert restored.jobs() == jobs
        assert restored.paused(), "Node restore must preserve the controller's current pause state"
        assert restored.admit(value, [], [])["job_ids"] == accepted["job_ids"]
        assert not (root / "restore-pause").exists()
        assert not list(root.glob("before-restore-*")), "Node restore must not make job backups"
    finally:
        restored.close()


def test_node_restore_to_fresh_state_never_recreates_backed_up_jobs(tmp_path):
    source = Ledger(tmp_path / "source")
    try:
        nodes = [{"id": "garden", "url": "http://127.0.0.1:8188", "enabled": True}]
        source.configure(nodes)
        source.admit(batch(2), [[], []], [["garden"], ["garden"]])
        snapshot = source.root / "backups" / source.backup()["filename"]
    finally:
        source.close()
    root = tmp_path / "fresh"
    result = restore(snapshot, root)
    assert result.returncode == 0, result.stderr
    restored = Ledger(root)
    try:
        assert restored.workers() == nodes
        assert restored.jobs() == []
        assert restored.state()["batch_counts"] == {}
        assert restored.claim("garden") is None
    finally:
        restored.close()


def test_node_restore_rejects_legacy_job_databases(tmp_path):
    snapshot_root = tmp_path / "old"
    legacy_ledger(snapshot_root)
    root = tmp_path / "restored"
    root.mkdir()
    result = restore(snapshot_root / "fleet.sqlite", root)
    assert result.returncode != 0
    assert "node" in result.stderr.lower() and "json" in result.stderr.lower()
    assert not (root / "fleet.sqlite").exists()


def test_node_restore_rejects_removing_an_active_node_without_partial_changes(tmp_path):
    root = tmp_path / "state"
    store = Ledger(root)
    try:
        nodes = [{"id": "garden", "url": "http://127.0.0.1:8188", "enabled": True}]
        store.configure(nodes)
        store.admit(batch(1), [[]], [["garden"]])
        store.claim("garden")
        before = store.state()
    finally:
        store.close()
    snapshot = tmp_path / "empty.json"
    snapshot.write_text(json.dumps({"format": "comfyui-fleet-nodes", "version": 1, "nodes": []}))
    result = restore(snapshot, root)
    assert result.returncode != 0
    assert "active job" in result.stderr
    restored = Ledger(root)
    try:
        assert restored.state() == before
    finally:
        restored.close()
