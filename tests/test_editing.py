"""Batch revisions, edit ownership, and scheduling barriers at the ledger seam."""

import copy
import json
import sqlite3
import uuid

import pytest

from fleet.snapshots import difference, reconstruct
from fleet.store import Conflict, Ledger
from fleet.validation import canonical
from test_ledger import admit, batch, history


def credentials(edit):
    return {"edit_id": edit["id"], "token": edit["token"]}


def prepared_edit(store, edit, text="{new|prompt}"):
    source = {"nodes": [{"id": 9, "widgets_values": [text]}]}
    version = store.save_draft({**credentials(edit), "version": edit["version"], "source": source})
    jobs = batch(edit["count"])["jobs"]
    for index, job in enumerate(jobs):
        job["output"]["1"]["inputs"] = {"text": f"prepared-{index}", "seed": index}
        job["workflow"] = copy.deepcopy(source)
    return {
        **credentials(edit),
        "batch_id": edit["batch_id"],
        "operation_id": str(uuid.uuid4()),
        "version": version["version"],
        "source": source,
        "jobs": jobs,
    }


@pytest.mark.parametrize(
    "before,after",
    [
        ({"a": None, "b": [1, 2]}, {"b": [True, 2], "new": {"x/y": None}}),
        ({"x": [1, {"y": "a"}]}, {"x": [1, {"y": "b"}]}),
        ({"x": [1, 2]}, {"x": []}),
        ({"x": {"a": 1}}, {"x": [1]}),
        (False, 0),
        (1, 1.0),
        ({}, None),
        ([], {}),
    ],
)
def test_deltas_preserve_arbitrary_json_and_types(before, after):
    original = copy.deepcopy(before)
    delta = json.loads(difference(before, after))
    assert canonical(reconstruct(before, delta)) == canonical(after)
    assert before == original


def test_revision_survives_first_job_retirement_and_reconstructs_each_job(ledger):
    value = batch(100)
    value["source"] = {"nodes": [{"widgets_values": ["{a|b}"]}]}
    for index, job in enumerate(value["jobs"]):
        job["output"]["1"]["inputs"] = {"text": "shared " * 500, "seed": index}
        job["workflow"]["nodes"] = [{"widgets_values": [index, "shared " * 500]}]
    ids = admit(ledger, value)["job_ids"]
    assert ledger.db.execute("SELECT count(*) FROM batch_revisions").fetchone()[0] == 1
    stored = sum(len(row[0]) for row in ledger.db.execute("SELECT delta FROM job_snapshots"))
    assert stored < len(canonical(value)) / 10
    first = ledger.claim("a")
    ledger.finish(first["id"], history())
    ledger.collected(first["id"], {})
    ledger.prune()
    for index, key in enumerate(ids):
        assert ledger.job(key)["graph"] == value["jobs"][index]["output"]
        assert ledger.job(key)["workflow"] == value["jobs"][index]["workflow"]
    edit = ledger.begin_edit(value["batch_id"], str(uuid.uuid4()))
    assert edit["draft"] == value["source"]
    assert edit["count"] == 99


def test_edit_holds_at_batch_before_compatibility_or_suspension_filtering(ledger):
    first, second, third = batch(1), batch(2), batch(1)
    for value in (first, second, third):
        admit(ledger, value)
    ledger.begin_edit(second["batch_id"], str(uuid.uuid4()))
    assert ledger.claim("a")["batch_id"] == first["batch_id"]
    assert ledger.claim("b") is None
    with ledger.db:
        ledger.db.execute("INSERT INTO suspensions VALUES(?,'b')", (second["batch_id"],))
        ledger.db.execute(
            "UPDATE jobs SET eligible='[\"a\"]' WHERE batch_id=?", (second["batch_id"],)
        )
    assert ledger.claim("b") is None, "A worker must never skip the held batch"
    with pytest.raises(Conflict, match="locked"):
        ledger.reorder_batch(third["batch_id"], first["batch_id"])
    with pytest.raises(Conflict, match="locked"):
        admit(ledger, {**batch(1), "front": True})
    assert admit(ledger, batch(1))["accepted"], "Appending remains available"


def test_save_replaces_only_waiting_jobs_atomically_and_is_replayable(ledger):
    value = batch(4)
    ids = admit(ledger, value)["job_ids"]
    active = ledger.claim("a")
    before = ledger.jobs()
    edit = ledger.begin_edit(value["batch_id"], str(uuid.uuid4()))
    body = prepared_edit(ledger, edit)
    ledger.rename_batch(value["batch_id"], "Renamed during workflow editing")
    with pytest.raises(ValueError):
        ledger.commit_edit(body, [], [])
    assert ledger.jobs() == before
    assert ledger.edit_state()
    answer = ledger.commit_edit(body, [[], [], []], [["b"]] * 3)
    assert answer["job_ids"] == ids[1:]
    assert ledger.job(active["id"]) == active
    assert ledger.edit_state() is None
    assert ledger.state()["batch_names"][value["batch_id"]] == "Renamed during workflow editing"
    assert ledger.commit_edit(body, [], [])["replayed"]
    for index, key in enumerate(ids[1:]):
        row = ledger.job(key)
        assert row["graph"] == body["jobs"][index]["output"]
        assert row["ordinal"] == index + 1
        assert row["priority"] == before[index + 1]["priority"]
    with pytest.raises(Conflict):
        ledger.commit_edit({**body, "source": {"nodes": []}}, [], [])
    resumed = ledger.begin_edit(value["batch_id"], str(uuid.uuid4()))
    assert resumed["draft"] == body["source"]


def test_durable_draft_single_writer_fencing_and_discard(ledger):
    value = batch(2)
    admit(ledger, value)
    original = ledger.jobs()
    owner = str(uuid.uuid4())
    edit = ledger.begin_edit(value["batch_id"], owner)
    body = prepared_edit(ledger, edit)
    with pytest.raises(Conflict, match="another browser"):
        ledger.begin_edit(value["batch_id"], str(uuid.uuid4()))
    other = batch(1)
    admit(ledger, other)
    with pytest.raises(Conflict, match="current batch"):
        ledger.begin_edit(other["batch_id"], owner)
    with pytest.raises(Conflict, match="Discard"):
        ledger.cancel_queued(value["batch_id"])
    root = ledger.root
    ledger.close()
    reopened = Ledger(root)
    try:
        assert reopened.claim("a") is None
        recovered = reopened.begin_edit(value["batch_id"], owner)
        assert recovered["draft"] == body["source"]
        assert recovered["token"] != edit["token"]
        with pytest.raises(Conflict, match="no longer current"):
            reopened.commit_edit(body, [[], []], [["a"]] * 2)
        with pytest.raises(Conflict):
            reopened.save_draft({**credentials(edit), "source": value["source"], "version": 1})
        reopened.discard_edit(credentials(recovered))
        assert reopened.jobs()[:2] == original
        assert reopened.claim("a")["batch_id"] == value["batch_id"]
    finally:
        reopened.close()


def test_upgrade_from_two_drops_waiting_jobs_exactly_once(tmp_path):
    root = tmp_path / "state"
    store = Ledger(root)
    store.configure([{"id": "a", "url": "http://127.0.0.1:8188"}])
    old = batch(2)
    ids = store.admit(old, [[], []], [["a"]] * 2)["job_ids"]
    active = store.claim("a")
    store.begin_submit(active["id"])
    active = store.job(active["id"])
    store.close()
    with sqlite3.connect(root / "fleet.sqlite") as db:
        db.execute("PRAGMA user_version=2")
    upgraded = Ledger(root)
    try:
        assert upgraded.job(ids[1])["state"] == "cancelled"
        assert upgraded.job(ids[0]) == active
        new = batch(1)
        new_id = upgraded.admit(new, [[]], [["a"]])["job_ids"][0]
    finally:
        upgraded.close()
    restarted = Ledger(root)
    try:
        assert restarted.job(new_id)["state"] == "waiting"
        assert restarted.admit(old, [], [])["job_ids"] == ids
    finally:
        restarted.close()


def test_draft_retry_is_idempotent_and_an_expired_writer_is_fenced(ledger):
    value = batch(1)
    admit(ledger, value)
    edit = ledger.begin_edit(value["batch_id"], str(uuid.uuid4()))
    body = {**credentials(edit), "version": 0, "source": {"nodes": [{"x": "draft"}]}}
    assert ledger.save_draft(body) == ledger.save_draft(body) == {"version": 1}
    ledger.release_edit_owner(
        {**credentials(edit), "version": 1, "source": {"nodes": [{"x": "closing"}]}}
    )
    resumed = ledger.begin_edit(value["batch_id"], str(uuid.uuid4()))
    assert resumed["draft"] == {"nodes": [{"x": "closing"}]}
    with pytest.raises(Conflict):
        ledger.touch_edit(credentials(edit))
    assert ledger.edit_state()["id"] == edit["id"]


def test_failed_queue_reset_rolls_back_version_and_waiting_jobs(tmp_path, monkeypatch):
    root = tmp_path / "state"
    store = Ledger(root)
    store.configure([{"id": "a", "url": "http://127.0.0.1:8188"}])
    store.admit(batch(1), [[]], [["a"]])
    store.close()
    connect = sqlite3.connect
    with connect(root / "fleet.sqlite") as db:
        db.execute("PRAGMA user_version=2")

    def fail_reset(*args, **kwargs):
        db = connect(*args, **kwargs)
        db.set_authorizer(
            lambda action, first, *rest: sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_UPDATE and first == "jobs"
            else sqlite3.SQLITE_OK
        )
        return db

    monkeypatch.setattr(sqlite3, "connect", fail_reset)
    with pytest.raises(sqlite3.DatabaseError):
        Ledger(root)
    with connect(root / "fleet.sqlite") as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 2
        assert db.execute("SELECT state FROM jobs").fetchone()[0] == "waiting"
