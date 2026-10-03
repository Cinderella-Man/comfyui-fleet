import copy
import json
import sqlite3
import uuid

import pytest

from fleet.store import Conflict, Ledger
import fleet.store as store_module


def batch(count=8):
    return {
        "batch_id": str(uuid.uuid4()),
        "source": {"nodes": []},
        "jobs": [
            {
                "output": {"1": {"class_type": "SaveImage", "inputs": {"filename_prefix": "test"}}},
                "workflow": {"nodes": [], "id": "workflow-1"},
            }
            for _ in range(count)
        ],
    }


@pytest.fixture
def ledger(tmp_path):
    store = Ledger(tmp_path / "state")
    store.configure(
        [{"id": x, "url": f"http://127.0.0.{i + 1}:8188"} for i, x in enumerate(["a", "b"])]
    )
    yield store
    store.close()


def admit(store, value):
    return store.admit(value, [[] for _ in value["jobs"]], [["a", "b"] for _ in value["jobs"]])


def history(ok=True):
    return {
        "status": {
            "status_str": "success" if ok else "error",
            "completed": ok,
            "messages": [["execution_success" if ok else "execution_error", {}]],
        },
        "outputs": {},
    }


def test_atomic_admission_idempotence_and_collision(ledger):
    value = batch()
    first = admit(ledger, value)
    assert admit(ledger, value)["job_ids"] == first["job_ids"]
    changed = copy.deepcopy(value)
    changed["jobs"][0]["output"]["1"]["inputs"]["filename_prefix"] = "different"
    with pytest.raises(Conflict):
        admit(ledger, changed)
    assert len(ledger.jobs()) == 8
    broken = batch(2)
    broken["jobs"][1]["output"] = {}
    with pytest.raises(ValueError):
        admit(ledger, broken)
    assert len(ledger.jobs()) == 8


def test_one_slot_across_batches_independent_refill_and_failure_suspension(ledger):
    first, second = batch(3), batch(2)
    admit(ledger, first)
    admit(ledger, second)
    a, b = ledger.claim("a"), ledger.claim("b")
    assert a["id"] != b["id"]
    assert ledger.claim("a")["id"] == a["id"]
    ledger.begin_submit(a["id"])
    ledger.submitted(a["id"], 200, {"prompt_id": a["remote_id"]})
    ledger.finish(a["id"], history(False))
    # A is suspended only for this batch; B's slot is still reserved.
    assert ledger.claim("a")["batch_id"] == second["batch_id"]
    assert ledger.claim("b")["id"] == b["id"]


def test_node_order_survives_restart_and_claim_timing_cannot_override_priority(ledger):
    ids = admit(ledger, batch(3))["job_ids"]
    assert [w["id"] for w in ledger.reorder_worker("b", "a")] == ["b", "a"]
    assert ledger.claim("a") is None, "A lower node polling first cannot take the next job"
    first = ledger.claim("b")
    assert first["id"] == ids[0]
    assert ledger.claim("a")["id"] == ids[1], "Busy higher nodes do not block free lower nodes"
    before = ledger.jobs()
    ledger.reorder_worker("a", "b")
    assert ledger.jobs() == before, "Reordering never reassigns active work"
    ledger.finish(first["id"], history())
    assert ledger.claim("b")["id"] == ids[2]
    ledger.reorder_worker("b", "a")
    # A stale settings/toggle save must not put the order back.
    ledger.configure(
        [{"id": "a", "url": "http://127.0.0.1:8188"}, {"id": "b", "url": "http://127.0.0.2:8188"}]
    )
    root = ledger.root
    ledger.close()
    restored = Ledger(root)
    try:
        assert [w["id"] for w in restored.workers()] == ["b", "a"]
        assert restored.claim("b")["id"] == ids[2]
    finally:
        restored.close()


def test_preference_skips_disabled_incompatible_and_batch_suspended_nodes(ledger):
    ledger.configure(
        [
            {"id": "a", "url": "http://127.0.0.1:8188", "enabled": False},
            {"id": "b", "url": "http://127.0.0.2:8188"},
        ]
    )
    admit(ledger, batch(1))
    assert ledger.claim("a") is None
    row = ledger.claim("b")
    ledger.finish(row["id"], history())
    ledger.configure(
        [{"id": "a", "url": "http://127.0.0.1:8188"}, {"id": "b", "url": "http://127.0.0.2:8188"}]
    )
    ledger.admit(batch(1), [[]], [["b"]])
    assert ledger.claim("a") is None
    row = ledger.claim("b")
    ledger.finish(row["id"], history())
    admit(ledger, batch(2))
    row = ledger.claim("a")
    ledger.finish(row["id"], history(False))
    assert ledger.claim("a") is None
    assert ledger.claim("b")["ordinal"] == 1


def test_node_moves_validate_current_nodes_and_preserve_concurrent_configuration(ledger):
    before = ledger.state()
    for source, target, error in [
        ("missing", "a", Conflict),
        ("a", "missing", Conflict),
        ("a", "a", ValueError),
        ([], None, ValueError),
        ("a", {}, ValueError),
    ]:
        with pytest.raises(error):
            ledger.reorder_worker(source, target)
        assert ledger.state() == before
    ledger.reorder_worker("b", "a")
    ledger.configure(
        [
            {"id": "a", "url": "http://127.0.0.1:8188"},
            {"id": "b", "url": "http://127.0.0.2:8188", "enabled": False},
            {"id": "c", "url": "http://127.0.0.3:8188"},
        ]
    )
    assert [w["id"] for w in ledger.workers()] == ["b", "a", "c"]
    moved = ledger.reorder_worker("b", None)
    assert [w["id"] for w in moved] == ["a", "c", "b"]
    assert not moved[-1]["enabled"]


def test_crash_after_intent_never_allows_second_post(ledger):
    admit(ledger, batch(2))
    a = ledger.claim("a")
    assert ledger.begin_submit(a["id"])
    assert not ledger.begin_submit(a["id"])
    root = ledger.root
    ledger.close()
    recovered = Ledger(root)
    try:
        row = recovered.claim("a")
        assert row["id"] == a["id"] and row["submit_intent"] == 1
        assert not recovered.begin_submit(row["id"])
        recovered.observe(row["id"], False)
        assert recovered.job(row["id"])["occupied"] == 1
    finally:
        recovered.close()


def test_cancellation_preparation_and_late_admission(ledger):
    accepted = admit(ledger, batch(3))
    waiting = accepted["job_ids"][-1]
    ledger.cancel([waiting])
    assert ledger.job(waiting)["state"] == "cancelled"
    a = ledger.claim("a")
    assert ledger.begin_submit(a["id"])
    ledger.cancel([a["id"]])
    ledger.observe(a["id"], False, False)  # still validating remotely
    assert ledger.job(a["id"])["occupied"]
    ledger.submitted(a["id"], 200, {"prompt_id": a["remote_id"]})
    ledger.observe(a["id"], True, True)  # interrupt was signalled, still running
    assert ledger.job(a["id"])["occupied"]
    ledger.observe(a["id"], False)
    assert ledger.job(a["id"])["state"] == "cancelled"
    assert ledger.claim("b") is None  # A is free again and still has first priority.
    b = ledger.claim("a")
    ledger.cancel([b["id"]])
    assert not ledger.begin_submit(b["id"])


def test_cancel_queue_preserves_assigned_jobs_and_accepts_new_work(ledger):
    admit(ledger, batch(4))
    admit(ledger, batch(3))
    preparing = ledger.claim("a")
    running = ledger.claim("b")
    ledger.begin_submit(running["id"])
    before = {key: ledger.job(key) for key in (preparing["id"], running["id"])}

    assert ledger.cancel_queued() == {"cancelled": 5}
    assert ledger.cancel_queued() == {"cancelled": 0}
    for key, row in before.items():
        assert ledger.job(key) == row
    cancelled = [row for row in ledger.jobs() if row["state"] == "cancelled"]
    assert len(cancelled) == 5
    assert all(row["cancel_requested"] and row["worker_id"] is None for row in cancelled)
    ledger.finish(running["id"], history())
    assert ledger.claim("b") is None
    later = admit(ledger, batch(1))
    assert ledger.claim("b")["id"] == later["job_ids"][0]
    assert not ledger.paused()


def test_cancel_queue_before_claim_leaves_nothing_to_dispatch(ledger):
    admit(ledger, batch(2))
    assert ledger.cancel_queued() == {"cancelled": 2}
    assert ledger.claim("a") is None
    assert ledger.claim("b") is None


def test_finished_jobs_do_not_prevent_removing_every_node(ledger):
    admit(ledger, batch(1))
    job = ledger.claim("a")
    ledger.begin_submit(job["id"])
    ledger.finish(job["id"], history())
    ledger.collected(job["id"], {})
    assert ledger.configure([]) == []
    assert ledger.state()["workers"] == []


def test_removal_preserves_active_work_and_can_transfer_queued_eligibility(ledger):
    value = batch(2)
    admit(ledger, value)
    a = ledger.claim("a")
    with pytest.raises(Conflict, match="active job"):
        ledger.configure([])
    assert len(ledger.workers()) == 2
    ledger.configure([{"id": "a", "url": "http://127.0.0.1:8188"}])
    assert ledger.jobs()[-1]["eligible"] == ["a"]
    ledger.cancel([a["id"]])
    with pytest.raises(Conflict, match="Queued jobs"):
        ledger.configure([])
    ledger.cancel_queued()
    assert ledger.configure([]) == []


def test_retention_keeps_batch_counts_and_receipts_without_finished_job_records(ledger):
    value = batch(3)
    for item in value["jobs"]:
        item["workflow"]["extra"] = {"fleet": {"workflow_name": "Portraits"}}
    accepted = admit(ledger, value)
    a = ledger.claim("a")
    ledger.begin_submit(a["id"])
    ledger.finish(a["id"], history())
    outputs = {"9": {"images": [{"filename": "portrait.png", "type": "output"}]}}
    ledger.collected(a["id"], outputs)
    ledger.prune()
    assert ledger.db.execute("SELECT count(*) FROM jobs").fetchone()[0] == 2
    assert ledger.job(a["id"])["outputs"] == outputs, "Normal history remains in memory"
    assert ledger.state()["batch_counts"][value["batch_id"]]["completed"] == 1
    assert ledger.state()["batch_counts"][value["batch_id"]]["total"] == 3
    assert ledger.state()["batch_names"][value["batch_id"]] == "Portraits"
    assert ledger.db.execute("SELECT count(*) FROM events").fetchone()[0] == 0
    ledger.prune()
    assert ledger.state()["batch_counts"][value["batch_id"]]["completed"] == 1
    root = ledger.root
    ledger.close()
    restored = Ledger(root)
    try:
        assert restored.job(a["id"]) is None, "History clears on restart like ComfyUI"
        assert restored.state()["batch_counts"][value["batch_id"]]["completed"] == 1
        assert admit(restored, value)["job_ids"] == accepted["job_ids"]
        assert len(restored.jobs()) == 2, "A replay cannot recreate finished jobs"
        restored.cancel_queued()
        restored.prune()
        assert restored.db.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0
        assert restored.state()["batch_counts"] == {}
        assert restored.state()["batch_names"] == {}
        assert restored.state()["suspensions"] == []
        assert admit(restored, value)["job_ids"] == accepted["job_ids"]
        assert restored.db.execute("PRAGMA user_version").fetchone()[0] == 3
        assert restored.db.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        restored.close()


def test_retention_preserves_collection_retry_and_uncertain_submission(ledger):
    admit(ledger, batch(3))
    a, b = ledger.claim("a"), ledger.claim("b")
    ledger.begin_submit(a["id"])
    ledger.finish(a["id"], history())
    ledger.collected(a["id"], None, "download failed")
    ledger.begin_submit(b["id"])
    ledger.submitted(b["id"], None, {})
    ledger.prune()
    assert ledger.db.execute("SELECT count(*) FROM jobs").fetchone()[0] == 3
    with pytest.raises(Conflict, match="results to collect"):
        ledger.configure([{"id": "b", "url": "http://127.0.0.2:8188"}])
    ledger.action(a["id"], "collect")
    assert ledger.pending_collection()[0]["id"] == a["id"]
    assert ledger.claim("b")["id"] == b["id"]
    assert not ledger.begin_submit(b["id"])


def test_retention_drains_all_finished_jobs_in_one_cleanup(ledger):
    value = batch(40)
    accepted = admit(ledger, value)
    ledger.cancel_queued()
    ledger.prune()
    assert ledger.db.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0
    assert ledger.state()["batch_names"] == {}
    assert ledger.batch(value["batch_id"])["job_ids"] == accepted["job_ids"]
    assert len(ledger.history) == 40


def test_collection_reads_only_recovery_fields_not_prompt_copies(ledger):
    admit(ledger, batch(1))
    row = ledger.claim("a")
    ledger.begin_submit(row["id"])
    ledger.finish(row["id"], history())
    pending = ledger.pending_collection()[0]
    assert pending["id"] == row["id"]
    assert "graph" not in pending and "workflow" not in pending
    assert ledger.job(row["id"])["workflow"], "Normal workflow history remains available"


def test_history_is_bounded_and_deleting_history_preserves_batch_counts(ledger, monkeypatch):
    monkeypatch.setattr(store_module, "HISTORY_LIMIT", 2)
    value = batch(4)
    accepted = admit(ledger, value)
    for _ in range(3):
        row = ledger.claim("a")
        ledger.cancel([row["id"]])
        ledger.prune()
    assert ledger.job(accepted["job_ids"][0]) is None
    assert len(ledger.history) == 2
    ledger.action(accepted["job_ids"][1], "hide")
    assert ledger.job(accepted["job_ids"][1]) is None
    assert ledger.state()["batch_counts"][value["batch_id"]]["cancelled"] == 3
    assert ledger.batch(value["batch_id"])["job_ids"] == accepted["job_ids"]


def test_retention_releases_snapshots_after_submit_but_keeps_waiting_inputs(ledger):
    value = batch(2)
    asset = {"sha256": "a" * 64}
    ledger.admit(value, [[asset], [asset]], [["a"], ["a"]])
    row = ledger.claim("a")
    assert ledger.prune() == {asset["sha256"]}
    ledger.begin_submit(row["id"])
    assert ledger.job(row["id"])["assets"] == []
    assert ledger.prune() == {asset["sha256"]}, "Another queued job still needs the snapshot"
    ledger.cancel_queued()
    assert ledger.prune() == set()
    assert ledger.claim("a")["id"] == row["id"], "Submitted jobs still reserve their slot"


def test_failed_cleanup_rolls_back_counts_and_keeps_jobs(ledger):
    value = batch(2)
    accepted = admit(ledger, value)
    ledger.cancel([accepted["job_ids"][0]])
    before = ledger.state()
    ledger.db.set_authorizer(
        lambda action, table, *_: sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_DELETE and table == "jobs"
        else sqlite3.SQLITE_OK
    )
    try:
        with pytest.raises(sqlite3.DatabaseError):
            ledger.prune()
    finally:
        ledger.db.set_authorizer(None)
    assert ledger.state() == before
    assert ledger.history == {}
    ledger.prune()
    assert ledger.state()["batch_counts"][value["batch_id"]]["cancelled"] == 1


def test_cancel_everything_preserves_results_and_waits_for_active_acknowledgement(ledger):
    admit(ledger, batch(4))
    admit(ledger, batch(3))
    completed = ledger.claim("a")
    ledger.begin_submit(completed["id"])
    ledger.finish(completed["id"], history())
    ledger.collected(completed["id"], {"9": {"images": [{"filename": "saved.png"}]}})
    finished = ledger.job(completed["id"])
    running, preparing = ledger.claim("a"), ledger.claim("b")
    ledger.begin_submit(running["id"])
    ledger.submitted(running["id"], 200, {"prompt_id": running["remote_id"]})

    assert ledger.cancel_all() == {"cancelled": 6}
    assert ledger.cancel_all() == {"cancelled": 0}
    assert ledger.job(completed["id"]) == finished
    assert ledger.job(preparing["id"])["state"] == "cancelled"
    assert not ledger.begin_submit(preparing["id"])
    assert ledger.claim("b") is None
    assert ledger.claim("a")["id"] == running["id"]
    assert ledger.job(running["id"])["cancel_requested"]
    ledger.observe(running["id"], True, True)
    assert ledger.job(running["id"])["occupied"]
    ledger.observe(running["id"], False)
    assert ledger.job(running["id"])["state"] == "cancelled"
    assert ledger.claim("a") is None
    later = admit(ledger, batch(1))
    assert ledger.claim("a")["id"] == later["job_ids"][0]
    assert not ledger.paused()


def test_cancel_everything_includes_unknown_occupied_jobs_but_not_released_outcomes(ledger):
    admit(ledger, batch(2))
    for worker in ("a", "b"):
        row = ledger.claim(worker)
        ledger.begin_submit(row["id"])
        ledger.submitted(row["id"], None, {})
        ledger.observe(row["id"], True)
        ledger.observe(row["id"], False)
    ledger.release_unknown(row["id"])
    released = ledger.job(row["id"])
    assert ledger.cancel_all() == {"cancelled": 1}
    assert ledger.claim("a")["cancel_requested"]
    assert ledger.job(row["id"]) == released


def test_cancel_everything_handles_more_than_one_batch_of_1000_jobs(ledger):
    admit(ledger, batch(1000))
    admit(ledger, batch(2))
    ledger.pause(True)
    assert ledger.cancel_all() == {"cancelled": 1002}
    assert all(row["state"] == "cancelled" for row in ledger.jobs())
    assert ledger.paused()
    assert ledger.claim("a") is None


def test_cancel_everything_rolls_back_all_requests_on_storage_failure(ledger):
    ids = admit(ledger, batch(3))["job_ids"]
    before = ledger.state()
    ledger.db.execute(
        f"CREATE TRIGGER reject_cancel BEFORE UPDATE ON jobs "
        f"WHEN NEW.id='{ids[1]}' AND NEW.cancel_requested=1 "
        "BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END"
    )
    with pytest.raises(sqlite3.IntegrityError, match="simulated storage failure"):
        ledger.cancel_all()
    assert ledger.state() == before
    ledger.db.execute("DROP TRIGGER reject_cancel")
    assert ledger.cancel_all() == {"cancelled": 3}


def test_cancel_queue_respects_recovery_pause(ledger):
    admit(ledger, batch(2))
    ledger.pause(True)
    assert ledger.cancel_queued() == {"cancelled": 2}
    assert ledger.paused()


def test_state_queue_follows_dispatch_priority(ledger):
    ids = admit(ledger, batch(3))["job_ids"]
    ledger.action(ids[-1], "front")
    assert [row["id"] for row in ledger.state()["jobs"]] == [ids[-1], *ids[:-1]]


def test_batch_name_persists_without_changing_jobs_source_order_or_edit_hold(ledger):
    value = batch(3)
    value["jobs"][0]["workflow"]["extra"] = {"fleet": {"workflow_name": "Original"}}
    receipt = admit(ledger, value)
    ledger.claim("a")
    ledger.begin_edit(value["batch_id"], str(uuid.uuid4()))
    jobs, hold = ledger.jobs(), ledger.edit_state()
    revision = [tuple(row) for row in ledger.db.execute("SELECT * FROM batch_revisions")]
    assert ledger.rename_batch(value["batch_id"], "  Finals — <v2>  ") == {
        "batch_id": value["batch_id"],
        "name": "Finals — <v2>",
    }
    assert ledger.jobs() == jobs
    assert ledger.edit_state() == hold
    assert [tuple(row) for row in ledger.db.execute("SELECT * FROM batch_revisions")] == revision
    assert admit(ledger, value)["job_ids"] == receipt["job_ids"]
    assert ledger.state()["batch_names"][value["batch_id"]] == "Finals — <v2>"
    root = ledger.root
    ledger.close()
    reopened = Ledger(root)
    try:
        assert reopened.state()["batch_names"][value["batch_id"]] == "Finals — <v2>"
        assert reopened.jobs() == jobs
        assert reopened.edit_state() == hold
    finally:
        reopened.close()


@pytest.mark.parametrize("name", [None, 7, "", "   ", "x" * 201, "a\nb", "a\x00b"])
def test_invalid_batch_names_preserve_the_existing_name(ledger, name):
    value = batch(1)
    admit(ledger, value)
    ledger.rename_batch(value["batch_id"], "Original")
    with pytest.raises(ValueError, match="Batch name"):
        ledger.rename_batch(value["batch_id"], name)
    assert ledger.state()["batch_names"][value["batch_id"]] == "Original"


def test_batch_rename_rejects_a_batch_that_left_the_queue(ledger):
    value = batch(1)
    admit(ledger, value)
    ledger.rename_batch(value["batch_id"], "Original")
    ledger.claim("a")
    with pytest.raises(Conflict, match="no longer has queued jobs"):
        ledger.rename_batch(value["batch_id"], "Too late")
    with pytest.raises(Conflict, match="no longer has queued jobs"):
        ledger.rename_batch(str(uuid.uuid4()), "Missing")
    assert ledger.state()["batch_names"][value["batch_id"]] == "Original"


def test_batch_reorder_persists_and_preserves_assigned_and_completed_jobs(ledger):
    first, second, third = batch(4), batch(3), batch(2)
    first["jobs"][0]["workflow"]["extra"] = {"fleet": {"workflow_name": "Portraits"}}
    for value in (first, second, third):
        admit(ledger, value)
    finished = ledger.claim("a")
    ledger.finish(finished["id"], history())
    active = ledger.claim("a")
    ledger.begin_submit(active["id"])
    preserved = {key: ledger.job(key) for key in (finished["id"], active["id"])}
    assert ledger.state()["batch_names"] == {first["batch_id"]: "Portraits"}
    order = [third["batch_id"], first["batch_id"], second["batch_id"]]
    assert ledger.reorder_batch(third["batch_id"], first["batch_id"]) == {"batch_ids": order}
    for key, row in preserved.items():
        assert ledger.job(key) == row
    root = ledger.root
    ledger.close()
    reopened = Ledger(root)
    try:
        assert reopened.db.execute("PRAGMA user_version").fetchone()[0] == 3
        assert reopened.state()["batch_names"] == {first["batch_id"]: "Portraits"}
        claimed = []
        for _ in range(7):
            job = reopened.claim("b")
            claimed.append((job["batch_id"], job["ordinal"]))
            reopened.finish(job["id"], history())
        assert claimed == [(third["batch_id"], i) for i in range(2)] + [
            (first["batch_id"], i) for i in (2, 3)
        ] + [(second["batch_id"], i) for i in range(3)]
        assert reopened.claim("b") is None
        assert reopened.job(active["id"]) == preserved[active["id"]]
    finally:
        reopened.close()


def test_reorder_uses_current_queue_and_keeps_new_arrivals(ledger):
    batches = [batch(2) for _ in range(12)]
    for value in batches:
        admit(ledger, value)
    # Another admission and an assignment since the browser picked up the card.
    later = batch(1)
    admit(ledger, later)
    assigned = ledger.claim("a")
    ids = [value["batch_id"] for value in batches]
    assert ledger.reorder_batch(ids[0], None)["batch_ids"] == [*ids[1:], later["batch_id"], ids[0]]
    assert ledger.job(assigned["id"]) == assigned
    assert ledger.claim("b")["batch_id"] == ids[1]


def test_stale_or_invalid_batch_moves_leave_the_queue_unchanged(ledger):
    first, second = batch(1), batch(1)
    for value in (first, second):
        admit(ledger, value)
    ledger.claim("a")  # First batch has no queued jobs now.
    before = ledger.state()
    for source, target in (
        (first["batch_id"], second["batch_id"]),
        (second["batch_id"], first["batch_id"]),
    ):
        with pytest.raises(Conflict, match="queue changed"):
            ledger.reorder_batch(source, target)
        assert ledger.state() == before
    for source, target in (
        (second["batch_id"], second["batch_id"]),
        ("invalid", None),
        (second["batch_id"], "invalid"),
    ):
        with pytest.raises(ValueError):
            ledger.reorder_batch(source, target)
        assert ledger.state() == before


def test_batch_reorder_is_atomic_on_storage_failure(ledger):
    first, second = batch(2), batch(2)
    admit(ledger, first)
    ids = admit(ledger, second)["job_ids"]
    before = ledger.state()
    priorities = [row["priority"] for row in ledger.jobs()]
    ledger.db.execute(
        f"CREATE TRIGGER reject_priority BEFORE UPDATE OF priority ON jobs WHEN NEW.id='{ids[1]}' "
        "BEGIN SELECT RAISE(ABORT, 'simulated reorder failure'); END"
    )
    with pytest.raises(sqlite3.IntegrityError, match="simulated reorder failure"):
        ledger.reorder_batch(second["batch_id"], first["batch_id"])
    assert ledger.state() == before
    assert [row["priority"] for row in ledger.jobs()] == priorities


def test_cancel_batch_preserves_later_batch_and_completed_outputs(ledger):
    first, second = batch(3), batch(2)
    admit(ledger, first)
    admit(ledger, second)
    a = ledger.claim("a")
    ledger.begin_submit(a["id"])
    ledger.finish(a["id"], history())
    ledger.collected(a["id"], {"9": {"images": [{"filename": "saved.png"}]}})
    ledger.cancel(batch_id=first["batch_id"])
    assert ledger.job(a["id"])["outputs"]["9"]["images"][0]["filename"] == "saved.png"
    assert ledger.claim("a")["batch_id"] == second["batch_id"]


def test_unknown_stays_reserved_and_configuration_cannot_orphan_it(ledger):
    admit(ledger, batch(2))
    a = ledger.claim("a")
    ledger.begin_submit(a["id"])
    ledger.submitted(a["id"], None, {})
    ledger.observe(a["id"], False)
    assert ledger.claim("a")["id"] == a["id"]
    with pytest.raises(Conflict):
        ledger.action(a["id"], "retry")
    with pytest.raises(Conflict):
        ledger.configure([])


def test_collection_retry_is_not_execution_and_old_jobs_cannot_be_resubmitted(ledger):
    admit(ledger, batch(1))
    a = ledger.claim("a")
    ledger.begin_submit(a["id"])
    ledger.finish(a["id"], history(False))
    with pytest.raises(Conflict):
        ledger.action(a["id"], "retry")
    assert ledger.job(a["id"])["state"] == "failed"
    ledger.collected(a["id"], None, "download failed")
    ledger.action(a["id"], "collect")
    assert len(ledger.jobs()) == 1
    assert ledger.job(a["id"])["collection_state"] == "pending"


def test_single_owner_node_backup_and_existing_restore_pause(tmp_path):
    root = tmp_path / "data"
    one = Ledger(root)
    try:
        with pytest.raises(BlockingIOError):
            Ledger(root)
        backup = one.backup()
        assert json.loads((root / "backups" / backup["filename"]).read_text()) == {
            "format": "comfyui-fleet-nodes",
            "version": 1,
            "nodes": [],
        }
    finally:
        one.close()
    (root / "restore-pause").touch()
    restored = Ledger(root)
    try:
        assert restored.paused()
        with pytest.raises(Conflict):
            restored.pause(False)
    finally:
        restored.close()


def test_schema_and_symlink_fail_without_erasing(tmp_path):
    root = tmp_path / "schema"
    root.mkdir()
    with sqlite3.connect(root / "fleet.sqlite") as db:
        db.execute("PRAGMA user_version=987")
    with pytest.raises(ValueError):
        Ledger(root)
    with sqlite3.connect(root / "fleet.sqlite") as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 987
    link = tmp_path / "linked"
    link.symlink_to(root, target_is_directory=True)
    with pytest.raises(ValueError):
        Ledger(link)


def test_sqlite_full_rolls_back_entire_batch_and_recovers(tmp_path):
    store = Ledger(tmp_path / "full")
    try:
        store.configure([{"id": "a", "url": "http://127.0.0.1:8188"}])
        pages = store.db.execute("PRAGMA page_count").fetchone()[0]
        store.db.execute(f"PRAGMA max_page_count={pages}")
        value = batch(2)
        value["jobs"][1]["workflow"]["payload"] = "x" * 200000
        with pytest.raises(sqlite3.OperationalError, match="full"):
            admit(store, value)
        assert store.jobs() == [] and store.batch(value["batch_id"]) is None
        assert store.db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        store.db.execute("PRAGMA max_page_count=10000")
        assert len(admit(store, value)["job_ids"]) == 2
    finally:
        store.close()


def test_manual_capacity_release_requires_settled_submission(ledger):
    admit(ledger, batch(1))
    row = ledger.claim("a")
    ledger.begin_submit(row["id"])
    ledger.submitted(row["id"], None, {})
    with pytest.raises(Conflict):
        ledger.release_unknown(row["id"])
    ledger.observe(row["id"], True)
    ledger.observe(row["id"], False)
    ledger.release_unknown(row["id"])
    assert ledger.job(row["id"])["state"] == "unknown"
    assert ledger.job(row["id"])["occupied"] == 0
    assert ledger.job(row["id"])["collection_state"] == "unavailable"


def test_successful_collection_retry_clears_transfer_error_only(ledger):
    admit(ledger, batch(1))
    row = ledger.claim("a")
    ledger.begin_submit(row["id"])
    ledger.finish(row["id"], history())
    ledger.collected(row["id"], None, "temporary download failure")
    ledger.action(row["id"], "collect")
    ledger.collected(row["id"], {"99": {"images": []}})
    final = ledger.job(row["id"])
    assert final["state"] == "succeeded" and final["error"] is None
