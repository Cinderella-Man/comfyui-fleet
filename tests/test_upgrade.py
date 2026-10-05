"""Upgrade drops waiting work once, preserving assigned jobs and admission receipts."""

import asyncio
import copy
import hashlib
import json
import sqlite3
import uuid

import pytest

from fleet.controller import Controller
from fleet.store import Conflict, Ledger, Store
from fleet.validation import canonical
from test_ledger import batch, history


@pytest.mark.parametrize(
    "error", ["ValueError: Result download failed: HTTP 404", "OSError: offline"]
)
def test_old_collection_errors_finish_without_recovery_after_restart(tmp_path, error):
    root = tmp_path / "state"
    store = Ledger(root)
    try:
        store.configure([{"id": "one", "url": "http://127.0.0.1:8188"}])
        store.admit(batch(2), [[], []], [["one"], ["one"]])
        row = store.claim("one")
        store.begin_submit(row["id"])
        store.finish(row["id"], history())
        store.collected(row["id"], None, error)
        store.close()
        store = Ledger(root)
        assert store.pending_collection() == []
        assert store.job(row["id"])["error"] == error
        assert store.claim("one")["id"] != row["id"]
        with pytest.raises(Conflict):
            store.action(row["id"], "collect")
        store.prune()
        assert store.job(row["id"])["error"] == error
        assert store.db.execute("SELECT 1 FROM jobs WHERE id=?", (row["id"],)).fetchone() is None
    finally:
        store.close()


def test_previously_released_jobs_become_cancelled_without_releasing_unchecked_work(tmp_path):
    root = tmp_path / "state"
    store = Ledger(root)
    try:
        store.configure(
            [
                {"id": worker, "url": f"http://127.0.0.{i + 1}:8188"}
                for i, worker in enumerate(("a", "b"))
            ]
        )
        value = batch(5)
        store.admit(value, [[]] * 5, [["a", "b"]] * 5)

        def old_released_job():
            row = store.claim("a")
            store.begin_submit(row["id"])
            store.submitted(row["id"], None, {})
            with store.db:
                store.db.execute(
                    "UPDATE jobs SET occupied=0,collection_state='unavailable' WHERE id=?",
                    (row["id"],),
                )
            return row["id"]

        old_released_job()
        store.prune()  # One released outcome only remains in durable batch counts.
        released = old_released_job()
        active = store.claim("a")
        store.begin_submit(active["id"])
        store.submitted(active["id"], None, {})
        waiting = {job["id"] for job in store.waiting_jobs()}
        assert len(waiting) == 2
        store.close()

        for _ in range(2):
            store = Ledger(root)
            assert store.job(active["id"])["state"] == "unknown"
            assert store.job(active["id"])["occupied"] == 1
            assert {job["id"] for job in store.waiting_jobs()} == waiting
            counts = store.state()["batch_counts"][value["batch_id"]]
            assert counts == {"total": 5, "completed": 0, "failed": 0, "cancelled": 2, "review": 1}
            if store.job(released):
                assert store.job(released)["state"] == "cancelled"
                assert store.job(released)["ended"] is not None
                assert store.job(released)["collection_state"] == "not_applicable"
            store.prune()
            store.close()
    finally:
        store.close()


def legacy_ledger(root):
    root.mkdir()
    value = batch(4)
    del value["source"]
    legacy = {"batch_id": value["batch_id"], "runs": value["jobs"]}
    ids = [str(uuid.uuid4()) for _ in range(4)]
    with sqlite3.connect(root / "fleet.sqlite") as db:
        db.row_factory = sqlite3.Row
        db.executescript("""
            CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO settings VALUES('paused','false');
            CREATE TABLE workers(
                id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL);
            CREATE TABLE batches(
                id TEXT PRIMARY KEY, digest TEXT NOT NULL, created REAL NOT NULL,
                cancelled INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE runs(
                id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id),
                ordinal INTEGER NOT NULL, priority REAL NOT NULL, created REAL NOT NULL,
                graph TEXT NOT NULL, workflow TEXT NOT NULL, assets TEXT NOT NULL,
                eligible TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'waiting',
                worker_id TEXT REFERENCES workers(id), worker_url TEXT, remote_id TEXT UNIQUE,
                occupied INTEGER NOT NULL DEFAULT 0, submit_intent INTEGER NOT NULL DEFAULT 0,
                acknowledged INTEGER NOT NULL DEFAULT 0, observed INTEGER NOT NULL DEFAULT 0,
                cancel_requested INTEGER NOT NULL DEFAULT 0, cancel_ack INTEGER NOT NULL DEFAULT 0,
                started REAL, ended REAL, history TEXT, outputs TEXT, diagnostics TEXT,
                error TEXT, collection_state TEXT NOT NULL DEFAULT 'pending',
                hidden INTEGER NOT NULL DEFAULT 0, retry_of TEXT REFERENCES runs(id),
                UNIQUE(batch_id,ordinal));
            CREATE UNIQUE INDEX worker_slot ON runs(worker_id) WHERE occupied=1;
            CREATE TABLE suspensions(
                batch_id TEXT REFERENCES batches(id), worker_id TEXT REFERENCES workers(id),
                PRIMARY KEY(batch_id,worker_id));
            CREATE TABLE events(
                seq INTEGER PRIMARY KEY, time REAL NOT NULL, kind TEXT NOT NULL,
                run_id TEXT, detail TEXT NOT NULL);
            PRAGMA user_version=1;
        """)
        db.executemany(
            "INSERT INTO workers VALUES(?,?,?)",
            [("a", "http://127.0.0.1:8188", 1), ("b", "http://127.0.0.2:8188", 0)],
        )
        db.execute(
            "INSERT INTO batches(id,digest,created) VALUES(?,?,1)",
            (value["batch_id"], hashlib.sha256(canonical(legacy).encode()).hexdigest()),
        )
        for index, job in enumerate(value["jobs"]):
            db.execute(
                "INSERT INTO runs(id,batch_id,ordinal,priority,created,graph,workflow,assets,eligible) "
                "VALUES(?,?,?,?,1,?,?,?,?)",
                (
                    ids[index],
                    value["batch_id"],
                    index,
                    4 - index,
                    canonical(job["output"]),
                    canonical(job["workflow"]),
                    "[]",
                    '["a","b"]',
                ),
            )
        # A lost submission acknowledgement, a disabled node preparing work, and saved history.
        db.execute(
            "UPDATE runs SET state='unknown',worker_id='a',worker_url='http://127.0.0.1:8188',"
            "occupied=1,submit_intent=1,remote_id=? WHERE id=?",
            (str(uuid.uuid4()), ids[0]),
        )
        db.execute(
            "UPDATE runs SET state='preparing',worker_id='b',occupied=1,remote_id=? WHERE id=?",
            (str(uuid.uuid4()), ids[1]),
        )
        db.execute(
            "UPDATE runs SET state='failed',history=?,outputs=?,collection_state='collected' WHERE id=?",
            (canonical(history(False)), '{"9":{"text":["preserve me"]}}', ids[2]),
        )
        db.execute("UPDATE runs SET retry_of=? WHERE id=?", (ids[2], ids[3]))
        db.execute("INSERT INTO suspensions VALUES(?,'a')", (value["batch_id"],))
        db.execute("INSERT INTO events VALUES(1,1,'submit_intent',?,'{}')", (ids[0],))
        rows = [dict(row) for row in db.execute("SELECT * FROM runs ORDER BY ordinal")]
    return value, legacy, rows


def test_upgrade_preserves_job_identities_and_backs_up_only_nodes(tmp_path):
    root = tmp_path / "state"
    value, legacy, original = legacy_ledger(root)
    store = Ledger(root)
    try:
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == 4
        assert store.db.execute("PRAGMA foreign_key_check").fetchall() == []
        upgraded = [dict(row) for row in store.db.execute("SELECT * FROM jobs ORDER BY ordinal")]
        assert upgraded[:3] == original[:3]
        assert upgraded[3]["state"] == "cancelled"
        assert upgraded[3]["collection_state"] == "not_applicable"
        assert not store.waiting_jobs()
        state = store.state()
        assert [job["id"] for job in state["jobs"]] == [row["id"] for row in reversed(original)]
        assert state["events"][0]["job_id"] == original[0]["id"]
        assert state["suspensions"] == [{"batch_id": value["batch_id"], "worker_id": "a"}]
        assert not state["workers"][1]["enabled"] and not store.paused()
        assert store.claim("a")["remote_id"] == original[0]["remote_id"]
        assert not store.begin_submit(original[0]["id"]), "Never re-post an uncertain submission"
        for payload in (value, legacy):
            replay = store.admit(payload, [], [])
            assert replay["replayed"] and replay["job_ids"] == [row["id"] for row in original]
        with pytest.raises(sqlite3.IntegrityError):
            with store.db:
                store.db.execute(
                    "UPDATE jobs SET worker_id='a',occupied=1 WHERE id=?", (original[3]["id"],)
                )
        snapshots = list((root / "backups").iterdir())
        assert len(snapshots) == 1
        assert json.loads(snapshots[0].read_text()) == {
            "format": "comfyui-fleet-nodes",
            "version": 1,
            "nodes": [
                {"id": "a", "url": "http://127.0.0.1:8188", "enabled": True},
                {"id": "b", "url": "http://127.0.0.2:8188", "enabled": False},
            ],
        }
    finally:
        store.close()
    reopened = Ledger(root)
    reopened.close()
    assert list((root / "backups").iterdir()) == snapshots


def test_retention_cleans_legacy_history_without_losing_recovery_or_admission_receipts(tmp_path):
    root = tmp_path / "state"
    value, legacy, original = legacy_ledger(root)
    store = Ledger(root)
    try:
        store.prune()
        assert store.db.execute("SELECT count(*) FROM jobs").fetchone()[0] == 2
        assert store.db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert store.state()["batch_counts"][value["batch_id"]]["failed"] == 1
        assert store.job(original[2]["id"])["outputs"], "Collected results stay in session history"
        assert store.claim("a")["remote_id"] == original[0]["remote_id"]
        assert not store.begin_submit(original[0]["id"])
        assert store.admit(legacy, [], [])["job_ids"] == [row["id"] for row in original]
    finally:
        store.close()
    restored = Ledger(root)
    try:
        assert restored.job(original[2]["id"]) is None
        assert restored.state()["batch_counts"][value["batch_id"]]["failed"] == 1
        assert restored.admit(value, [], [])["job_ids"] == [row["id"] for row in original]
    finally:
        restored.close()


def test_failed_upgrade_rolls_back_all_schema_changes(tmp_path, monkeypatch):
    root = tmp_path / "state"
    legacy_ledger(root)
    connect = sqlite3.connect

    def fail_second_rename(*args, **kwargs):
        db = connect(*args, **kwargs)
        db.set_authorizer(
            lambda action, first, second, *rest: sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_ALTER_TABLE and second == "events"
            else sqlite3.SQLITE_OK
        )
        return db

    monkeypatch.setattr(sqlite3, "connect", fail_second_rename)
    with pytest.raises(sqlite3.DatabaseError, match="not authorized"):
        Ledger(root)
    with connect(root / "fleet.sqlite") as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM runs").fetchone()[0] == 4
        assert db.execute("SELECT run_id FROM events").fetchone()
        assert not db.execute("SELECT name FROM sqlite_master WHERE name='jobs'").fetchall()
    monkeypatch.setattr(sqlite3, "connect", connect)
    recovered = Ledger(root)
    recovered.close()


def test_controller_replays_old_admission_without_remote_access_and_rejects_changes(tmp_path):
    root = tmp_path / "state"
    value, legacy, original = legacy_ledger(root)

    async def scenario():
        store = Store(root)
        await store.open()
        try:
            control = Controller(store, None, None, lambda event: None)
            for payload in (value, legacy):
                replay = await control.admit(payload)
                assert replay["replayed"]
                assert replay["job_ids"] == [row["id"] for row in original]
            changed = copy.deepcopy(value)
            changed["jobs"][0]["workflow"]["id"] = "different"
            with pytest.raises(Conflict):
                await control.admit(changed)
            with pytest.raises(Conflict):
                await store.call("admit", changed, [], [])
            with pytest.raises(ValueError, match="only one job list"):
                await control.admit({**value, **legacy})
            assert len(await store.call("jobs")) == 4
        finally:
            await store.close()

    asyncio.run(scenario())
