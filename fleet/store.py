"""Transactional ledger. All production calls execute on one dedicated database thread.

Remote I/O never occurs here. A submit intent is irrevocable: after it commits,
recovery observes the identity and never issues another prompt POST for it.
"""

import asyncio
import copy
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid

from .snapshots import difference, reconstruct
from .validation import (
    TERMINAL,
    batch_digests,
    canonical,
    identity,
    prepared_batch,
    source_workflow,
    workers_config,
)

JSON_FIELDS = {"graph", "workflow", "assets", "history", "outputs", "diagnostics", "eligible"}
HISTORY_LIMIT = 10000  # Stock ComfyUI keeps a bounded, in-memory history too.


def owned_directory(path):
    path = Path(path)
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("Fleet storage must not contain symlinks")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def decode(row):
    if row is None:
        return None
    return {
        k: json.loads(v) if k in JSON_FIELDS and v is not None else v for k, v in dict(row).items()
    }


class Conflict(ValueError):
    """A valid request conflicts with persisted state."""


class Ledger:
    def __init__(self, root):
        self.root = owned_directory(root)
        self.lock = None
        self.db = None
        self.history = {}
        try:
            self.lock = os.open(
                self.root / "owner.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
            )
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for name in ("fleet.sqlite", "fleet.sqlite-journal", "restore-pause"):
                p = self.root / name
                if p.is_symlink() or (p.exists() and not p.is_file()):
                    raise ValueError("Nonregular Fleet state file")
            self.db = sqlite3.connect(self.root / "fleet.sqlite", timeout=2)
            (self.root / "fleet.sqlite").chmod(0o600)
            self.db.row_factory = sqlite3.Row
            version = self.db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2, 3):
                raise ValueError("Unsupported Fleet schema; no automatic downgrade")
            self.db.execute("PRAGMA journal_mode=DELETE")
            self.db.execute("PRAGMA synchronous=EXTRA")
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.execute("PRAGMA secure_delete=ON")
            if version == 1:
                # Save node configuration only; SQLite's transaction protects the upgrade.
                self.backup()
                with self.db:
                    self.db.execute("BEGIN IMMEDIATE")
                    self.db.execute("ALTER TABLE runs RENAME TO jobs")
                    self.db.execute("ALTER TABLE events RENAME COLUMN run_id TO job_id")
                    self.db.execute("PRAGMA user_version=2")
            self.db.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                INSERT OR IGNORE INTO settings VALUES('paused','false');
                CREATE TABLE IF NOT EXISTS workers(
                    id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS batches(
                    id TEXT PRIMARY KEY, digest TEXT NOT NULL, created REAL NOT NULL,
                    cancelled INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS jobs(
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
                    hidden INTEGER NOT NULL DEFAULT 0, retry_of TEXT REFERENCES jobs(id),
                    UNIQUE(batch_id,ordinal));
                CREATE UNIQUE INDEX IF NOT EXISTS worker_slot ON jobs(worker_id) WHERE occupied=1;
                CREATE TABLE IF NOT EXISTS suspensions(
                    batch_id TEXT REFERENCES batches(id), worker_id TEXT REFERENCES workers(id),
                    PRIMARY KEY(batch_id,worker_id));
                CREATE TABLE IF NOT EXISTS events(
                    seq INTEGER PRIMARY KEY, time REAL NOT NULL, kind TEXT NOT NULL,
                    job_id TEXT, detail TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS batch_receipts(
                    batch_id TEXT PRIMARY KEY REFERENCES batches(id), job_ids TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS batch_progress(
                    batch_id TEXT PRIMARY KEY REFERENCES batches(id), name TEXT,
                    completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
                    cancelled INTEGER NOT NULL DEFAULT 0, review INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS batch_revisions(
                    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id),
                    source TEXT NOT NULL, base TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS job_snapshots(
                    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
                    revision_id TEXT NOT NULL REFERENCES batch_revisions(id), delta TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS batch_edit(
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL,
                    batch_id TEXT NOT NULL REFERENCES batches(id), owner TEXT NOT NULL,
                    token TEXT NOT NULL, expires REAL NOT NULL, draft TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 0, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS edit_receipts(
                    id TEXT PRIMARY KEY, digest TEXT NOT NULL, answer TEXT NOT NULL);

            """)
            with self.db:
                for row in self.db.execute(
                    "SELECT id FROM batches WHERE id NOT IN (SELECT batch_id FROM batch_receipts)"
                ).fetchall():
                    self._record_batch(row["id"])
                if version in (1, 2):
                    # No conversion: only work already assigned survives the upgrade.
                    self.db.execute(
                        "UPDATE jobs SET state='cancelled',cancel_requested=1,ended=?,"
                        "collection_state='not_applicable' WHERE state='waiting' "
                        "AND worker_id IS NULL AND occupied=0 AND submit_intent=0",
                        (time.time(),),
                    )
                self.db.execute("PRAGMA user_version=3")
            if (self.root / "restore-pause").exists():
                self.pause(True)
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None
        self.history.clear()

    def event(self, kind, job_id=None, detail=None):
        self.db.execute(
            "INSERT INTO events(time,kind,job_id,detail) VALUES(?,?,?,?)",
            (time.time(), kind, job_id, canonical(detail or {})),
        )
        self.db.execute(
            "DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT 200)"
        )

    def _record_batch(self, batch_id, name=None):
        rows = self.db.execute(
            "SELECT id,json_extract(workflow,'$.extra.fleet.workflow_name') AS name "
            "FROM jobs WHERE batch_id=? ORDER BY ordinal",
            (batch_id,),
        ).fetchall()
        self.db.execute(
            "INSERT INTO batch_receipts VALUES(?,?)",
            (batch_id, canonical([row["id"] for row in rows])),
        )
        if name is None:
            name = rows[0]["name"] if rows else None
        self.db.execute(
            "INSERT INTO batch_progress(batch_id,name) VALUES(?,?)",
            (batch_id, name.strip()[:200] if isinstance(name, str) else None),
        )

    def _decode_job(self, row):
        item = decode(row)
        if item is None:
            return None
        snapshot = self.db.execute(
            "SELECT r.base,s.delta FROM job_snapshots s JOIN batch_revisions r "
            "ON r.id=s.revision_id WHERE s.job_id=?",
            (item["id"],),
        ).fetchone()
        if snapshot:
            pair = reconstruct(json.loads(snapshot["base"]), json.loads(snapshot["delta"]))
            item.update(graph=pair["output"], workflow=pair["workflow"])
        return item

    def _save_revision(self, body, ids):
        revision = str(uuid.uuid4())
        base = body["jobs"][0]
        self.db.execute(
            "INSERT INTO batch_revisions VALUES(?,?,?,?)",
            (revision, body["batch_id"], canonical(body["source"]), canonical(base)),
        )
        for job_id, pair in zip(ids, body["jobs"], strict=True):
            self.db.execute(
                "INSERT INTO job_snapshots VALUES(?,?,?) "
                "ON CONFLICT(job_id) DO UPDATE SET revision_id=excluded.revision_id,delta=excluded.delta",
                (job_id, revision, difference(base, pair)),
            )

    def edit_state(self):
        row = self.db.execute(
            "SELECT id,batch_id,owner,expires,version,updated FROM batch_edit"
        ).fetchone()
        return dict(row) if row else None

    def _edit_jobs(self, batch_id):
        return [
            self._decode_job(row)
            for row in self.db.execute(
                "SELECT * FROM jobs WHERE batch_id=? AND state='waiting' AND worker_id IS NULL "
                "AND occupied=0 AND submit_intent=0 ORDER BY ordinal",
                (batch_id,),
            ).fetchall()
        ]

    def _owned_edit(self, body):
        row = self.db.execute("SELECT * FROM batch_edit").fetchone()
        if not row or row["id"] != body["edit_id"] or row["token"] != body["token"]:
            raise Conflict("This edit session is no longer current. Resume it from the queue.")
        return row

    def begin_edit(self, batch_id, owner):
        identity(batch_id)
        identity(owner)
        with self.db:
            old = self.db.execute("SELECT * FROM batch_edit").fetchone()
            now = time.time()
            if old:
                if old["batch_id"] != batch_id:
                    raise Conflict("Finish or discard the current batch edit first")
                if old["owner"] != owner and old["expires"] > now:
                    raise Conflict("This batch is being edited in another browser tab")
                self.db.execute(
                    "UPDATE batch_edit SET owner=?,token=?,expires=?",
                    (owner, str(uuid.uuid4()), now + 20),
                )
            else:
                rows = self._edit_jobs(batch_id)
                if not rows:
                    raise Conflict("This batch no longer has queued jobs")
                revision = self.db.execute(
                    "SELECT source FROM batch_revisions r JOIN job_snapshots s ON r.id=s.revision_id "
                    "WHERE s.job_id=?",
                    (rows[0]["id"],),
                ).fetchone()
                if revision is None:
                    raise Conflict("This batch has no authored workflow")
                self.db.execute(
                    "INSERT INTO batch_edit VALUES(1,?,?,?,?,?,?,0,?)",
                    (
                        str(uuid.uuid4()),
                        batch_id,
                        owner,
                        str(uuid.uuid4()),
                        now + 20,
                        revision["source"],
                        now,
                    ),
                )
            row = dict(self.db.execute("SELECT * FROM batch_edit").fetchone())
            row["draft"] = json.loads(row["draft"])
            row["count"] = len(self._edit_jobs(batch_id))
            return row

    def save_draft(self, body):
        source_workflow(body["source"])
        with self.db:
            row = self._owned_edit(body)
            if row["version"] == body["version"] + 1 and row["draft"] == canonical(body["source"]):
                return {"version": row["version"]}
            if row["version"] != body["version"]:
                raise Conflict("The saved draft changed. Resume the latest draft from the queue.")
            now = time.time()
            self.db.execute(
                "UPDATE batch_edit SET draft=?,version=version+1,updated=?,expires=?",
                (canonical(body["source"]), now, now + 20),
            )
            return {"version": row["version"] + 1}

    def touch_edit(self, body):
        with self.db:
            self._owned_edit(body)
            self.db.execute("UPDATE batch_edit SET expires=?", (time.time() + 20,))
        return {"ok": True}

    def release_edit_owner(self, body):
        with self.db:
            row = self._owned_edit(body)
            if "source" in body and row["version"] == body["version"]:
                source_workflow(body["source"])
                self.db.execute(
                    "UPDATE batch_edit SET draft=?,version=version+1,updated=?",
                    (canonical(body["source"]), time.time()),
                )
            self.db.execute("UPDATE batch_edit SET expires=0")
        return {"ok": True}

    def discard_edit(self, body):
        with self.db:
            self._owned_edit(body)
            self.db.execute("DELETE FROM batch_edit")
        return {"discarded": True}

    def edit_receipt(self, body):
        identity(body["operation_id"])
        digest = hashlib.sha256(canonical(body).encode()).hexdigest()
        row = self.db.execute(
            "SELECT * FROM edit_receipts WHERE id=?", (body["operation_id"],)
        ).fetchone()
        if row:
            if row["digest"] != digest:
                raise Conflict("Save identity was already used for a different edit")
            return {**json.loads(row["answer"]), "replayed": True}
        return None

    def prepare_edit(self, body):
        row = self._owned_edit(body)
        if row["batch_id"] != body["batch_id"] or row["version"] != body["version"]:
            raise Conflict("The saved draft changed. Resume it before saving.")
        if canonical(body["source"]) != row["draft"]:
            raise Conflict("Save the authored draft before preparing its jobs")
        jobs = self._edit_jobs(row["batch_id"])
        if len(jobs) != len(body["jobs"]):
            raise Conflict("The queued job count changed; reload the draft")
        return jobs

    def commit_edit(self, body, assets, eligible):
        with self.db:
            prior = self.edit_receipt(body)
            if prior:
                return prior
            rows = self.prepare_edit(body)
            if len(assets) != len(rows) or len(eligible) != len(rows) or not all(eligible):
                raise ValueError("Every job needs a compatible enrolled worker")
            ids = [row["id"] for row in rows]
            self._save_revision(body, ids)
            for job_id, files, workers in zip(ids, assets, eligible, strict=True):
                self.db.execute(
                    "UPDATE jobs SET assets=?,eligible=? WHERE id=?",
                    (canonical(files), canonical(workers), job_id),
                )
            # An edited graph gets a fresh compatibility decision on every worker.
            self.db.execute("DELETE FROM suspensions WHERE batch_id=?", (body["batch_id"],))
            self.db.execute("DELETE FROM batch_edit")
            answer = {"saved": True, "batch_id": body["batch_id"], "job_ids": ids}
            self.db.execute(
                "INSERT INTO edit_receipts VALUES(?,?,?)",
                (
                    body["operation_id"],
                    hashlib.sha256(canonical(body).encode()).hexdigest(),
                    canonical(answer),
                ),
            )
            self.event("batch_edited", detail={"batch_id": body["batch_id"], "count": len(ids)})
            return answer

    def workers(self):
        workers = {r["id"]: dict(r) for r in self.db.execute("SELECT * FROM workers ORDER BY id")}
        saved = self.db.execute("SELECT value FROM settings WHERE key='worker_order'").fetchone()
        order = json.loads(saved[0]) if saved else []
        return [workers.pop(key) for key in order if key in workers] + list(workers.values())

    def _save_worker_order(self, order):
        self.db.execute(
            "INSERT INTO settings VALUES('worker_order',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (canonical(order),),
        )

    def reorder_worker(self, worker_id, before_worker_id):
        if not isinstance(worker_id, str) or (
            before_worker_id is not None and not isinstance(before_worker_id, str)
        ):
            raise ValueError("Expected node identities")
        if worker_id == before_worker_id:
            raise ValueError("A node cannot be moved before itself")
        with self.db:
            order = [worker["id"] for worker in self.workers()]
            if worker_id not in order or (
                before_worker_id is not None and before_worker_id not in order
            ):
                raise Conflict("The node list changed. Try reordering again.")
            order.remove(worker_id)
            index = len(order) if before_worker_id is None else order.index(before_worker_id)
            order.insert(index, worker_id)
            self._save_worker_order(order)
            self.event("workers_reordered", detail={"ids": order})
        return self.workers()

    def configure(self, values, verified=None, *, restore_order=False):
        values = workers_config(values)
        new = {w["id"]: w for w in values}
        with self.db:
            order = [worker["id"] for worker in self.workers() if worker["id"] in new]
            changed = {
                w["id"]
                for w in self.workers()
                if w["id"] not in new or w["url"] != new[w["id"]]["url"]
            }
            for key in changed:
                if self.db.execute(
                    "SELECT 1 FROM jobs WHERE worker_id=? AND (occupied=1 "
                    "OR (history IS NOT NULL AND collection_state IN ('pending','error')))",
                    (key,),
                ).fetchone():
                    raise Conflict(
                        f"“{key}” still has an active job or results to collect. "
                        "Let it finish, cancel its job, or resolve its recovery warning first. "
                        "You can disable the node to stop new assignments."
                    )
            for row in self.db.execute("SELECT id,eligible FROM jobs WHERE state='waiting'"):
                eligible = json.loads(row["eligible"])
                remaining = [key for key in eligible if key not in changed]
                for key in (verified or {}).get(row["id"], []):
                    if key in new and new[key]["enabled"] and key not in remaining:
                        remaining.append(key)
                if remaining == eligible:
                    continue
                if not remaining:
                    raise Conflict(
                        "Queued jobs still need the nodes you are removing. "
                        "Cancel those queued jobs or let them finish, then save your node list again."
                    )
                self.db.execute(
                    "UPDATE jobs SET eligible=? WHERE id=?", (canonical(remaining), row["id"])
                )
            for key in changed:
                self.db.execute(
                    "UPDATE jobs SET worker_id=NULL,worker_url=NULL WHERE worker_id=?", (key,)
                )
                self.db.execute("DELETE FROM suspensions WHERE worker_id=?", (key,))
            for old in self.workers():
                if old["id"] not in new:
                    self.db.execute("DELETE FROM workers WHERE id=?", (old["id"],))
            for w in values:
                self.db.execute(
                    "INSERT INTO workers VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,enabled=excluded.enabled",
                    (w["id"], w["url"], w["enabled"]),
                )
            # Browser saves may contain stale order; append newly added nodes.
            # Offline node restoration explicitly applies the backup's order.
            self._save_worker_order(
                list(new) if restore_order else order + [key for key in new if key not in order]
            )
            self.event("workers_configured", detail={"ids": list(new)})
        return self.workers()

    def paused(self):
        return (
            self.db.execute("SELECT value FROM settings WHERE key='paused'").fetchone()[0] == "true"
        )

    def pause(self, value):
        if not isinstance(value, bool):
            raise ValueError("Paused must be a boolean")
        if not value and (self.root / "restore-pause").exists():
            raise Conflict(
                "Restored backup requires operator reconciliation; see recovery instructions"
            )
        with self.db:
            self.db.execute("UPDATE settings SET value=? WHERE key='paused'", (canonical(value),))
            self.event("scheduler_paused", detail={"paused": value})

    def batch(self, batch_id):
        row = self.db.execute("SELECT * FROM batches WHERE id=?", (identity(batch_id),)).fetchone()
        if row is None:
            return None
        ids = json.loads(
            self.db.execute(
                "SELECT job_ids FROM batch_receipts WHERE batch_id=?", (batch_id,)
            ).fetchone()[0]
        )
        return {"accepted": True, "batch_id": batch_id, "job_ids": ids, "digest": row["digest"]}

    def admit(self, body, assets, eligible):
        body = prepared_batch(body)
        digests = batch_digests(body)
        with self.db:
            old = self.batch(body["batch_id"])
            if old:
                if old["digest"] not in digests:
                    raise Conflict("Batch identity was already used for different settings")
                return {**old, "replayed": True}
            source_workflow(body.get("source"))
            if self.paused():
                raise Conflict("Scheduler is paused; no new jobs accepted")
            if (
                len(assets) != len(body["jobs"])
                or len(eligible) != len(body["jobs"])
                or not all(eligible)
            ):
                raise ValueError("Every job needs a compatible enrolled worker")
            now = time.time()
            last = self.db.execute("SELECT COALESCE(MAX(priority),0) FROM jobs").fetchone()[0]
            if body.get("front") and self.edit_state():
                raise Conflict("Queue order is locked while a batch is being edited")
            if body.get("front"):
                last = (
                    self.db.execute("SELECT COALESCE(MIN(priority),0) FROM jobs").fetchone()[0]
                    - len(assets)
                    - 1
                )
            self.db.execute(
                "INSERT INTO batches(id,digest,created) VALUES(?,?,?)",
                (body["batch_id"], digests[0], now),
            )
            for i in range(len(body["jobs"])):
                self.db.execute(
                    """INSERT INTO jobs(id,batch_id,ordinal,priority,created,graph,workflow,assets,eligible)
                                VALUES(?,?,?,?,?,?,?,?,?)""",
                    (
                        str(uuid.uuid4()),
                        body["batch_id"],
                        i,
                        last + i + 1,
                        now,
                        "{}",
                        "{}",
                        canonical(assets[i]),
                        canonical(eligible[i]),
                    ),
                )
            extra = body["jobs"][0]["workflow"].get("extra")
            metadata = extra.get("fleet") if isinstance(extra, dict) else None
            name = metadata.get("workflow_name") if isinstance(metadata, dict) else None
            self._record_batch(body["batch_id"], name)
            self._save_revision(
                body,
                [
                    row[0]
                    for row in self.db.execute(
                        "SELECT id FROM jobs WHERE batch_id=? ORDER BY ordinal", (body["batch_id"],)
                    )
                ],
            )
            self.event(
                "batch_accepted", detail={"batch_id": body["batch_id"], "count": len(assets)}
            )
        return {**self.batch(body["batch_id"]), "replayed": False}

    def jobs(self, active_only=False):
        sql = (
            "SELECT * FROM jobs"
            + (" WHERE occupied=1" if active_only else "")
            + " ORDER BY priority,created,ordinal"
        )
        rows = [self._decode_job(r) for r in self.db.execute(sql)]
        if not active_only:
            rows.extend(copy.deepcopy(list(self.history.values())))
            rows.sort(key=lambda row: (row["priority"], row["created"], row["ordinal"]))
        return rows

    def waiting_jobs(self):
        return [
            self._decode_job(row)
            for row in self.db.execute(
                "SELECT * FROM jobs WHERE state='waiting' AND worker_id IS NULL "
                "AND occupied=0 AND submit_intent=0 ORDER BY priority,created,ordinal"
            )
        ]

    def job(self, job_id):
        row = self._decode_job(
            self.db.execute("SELECT * FROM jobs WHERE id=?", (identity(job_id),)).fetchone()
        )
        if row is not None:
            return row
        cached = self.history.get(job_id)
        return copy.deepcopy(cached) if cached and not cached["hidden"] else None

    def _hide_history(self, job_id):
        # Keep only the small ownership record so a self-worker's native history
        # cannot reappear as an unrelated job after the Fleet entry is deleted.
        self.history[job_id].update(
            hidden=1,
            graph={},
            workflow={},
            history=None,
            outputs=None,
            diagnostics=None,
            error=None,
        )

    def _retire_finished(self):
        """Commit a bounded chunk before exposing it in normal in-memory history."""
        with self.db:
            self.db.execute(
                "UPDATE jobs SET assets='[]',eligible='[]' WHERE submit_intent=1 AND (assets!='[]' OR eligible!='[]')"
            )
            retired = self.db.execute(
                "SELECT * FROM jobs WHERE occupied=0 AND "
                "((state IN ('succeeded','failed','cancelled') "
                "AND collection_state NOT IN ('pending','error')) "
                "OR (state='unknown' AND collection_state='unavailable')) ORDER BY ended,created LIMIT 16"
            ).fetchall()
            retired = [self._decode_job(row) for row in retired]
            for row in retired:
                count = {"succeeded": "completed", "unknown": "review"}.get(
                    row["state"], row["state"]
                )
                self.db.execute(
                    f"UPDATE batch_progress SET {count}={count}+1 WHERE batch_id=?",
                    (row["batch_id"],),
                )
                self.db.execute("UPDATE jobs SET retry_of=NULL WHERE retry_of=?", (row["id"],))
                self.db.execute("DELETE FROM jobs WHERE id=?", (row["id"],))
            self.db.execute(
                "DELETE FROM batch_progress WHERE batch_id NOT IN (SELECT batch_id FROM jobs)"
            )
            self.db.execute(
                "DELETE FROM suspensions WHERE batch_id NOT IN (SELECT batch_id FROM jobs WHERE state='waiting')"
            )
            self.db.execute(
                "DELETE FROM batch_revisions WHERE id NOT IN "
                "(SELECT revision_id FROM job_snapshots)"
            )
            self.db.execute("DELETE FROM events")
        for row in retired:
            item = row
            item.update(assets=[], eligible=[], worker_url=None, retry_of=None)
            item["history"] = {"status": item["history"].get("status")} if item["history"] else None
            self.history[row["id"]] = item
            if row["hidden"]:
                self._hide_history(row["id"])
        while len(self.history) > HISTORY_LIMIT:
            del self.history[next(iter(self.history))]
        return len(retired)

    def prune(self):
        """Drain finished work without loading an entire old ledger into memory."""
        while self._retire_finished() == 16:
            pass
        # Reclaim accumulated free pages without rewriting the database on every poll.
        free = self.db.execute("PRAGMA freelist_count").fetchone()[0]
        if free > 1024 and free > self.db.execute("PRAGMA page_count").fetchone()[0] / 2:
            self.db.execute("VACUUM")
        return {
            asset["sha256"]
            for row in self.db.execute("SELECT assets FROM jobs")
            for asset in json.loads(row["assets"])
        }

    def active_identity(self, worker, remote_id):
        row = self.db.execute(
            "SELECT id FROM jobs WHERE worker_id=? AND remote_id=? AND occupied=1",
            (worker, remote_id),
        ).fetchone()
        return dict(row) if row else None

    def active_ids(self):
        return {row[0] for row in self.db.execute("SELECT id FROM jobs WHERE occupied=1")}

    def pending_collection(self):
        return [
            decode(r)
            for r in self.db.execute(
                "SELECT id,batch_id,remote_id,worker_url,history,collection_state FROM jobs "
                "WHERE history IS NOT NULL AND collection_state='pending' ORDER BY ended LIMIT 1"
            )
        ]

    def release_unknown(self, job_id):
        with self.db:
            row = self.job(job_id)
            if row["state"] != "unknown" or not (row["acknowledged"] or row["observed"]):
                raise Conflict("Cannot release a submission that may still arrive")
            self.db.execute(
                "UPDATE jobs SET occupied=0,collection_state='unavailable' WHERE id=?", (job_id,)
            )
            self.event("manual_capacity_release", job_id)

    def claim(self, worker):
        with self.db:
            busy = self.db.execute(
                "SELECT * FROM jobs WHERE worker_id=? AND occupied=1", (worker,)
            ).fetchone()
            if busy:
                return self._decode_job(busy)
            w = self.db.execute(
                "SELECT * FROM workers WHERE id=? AND enabled=1", (worker,)
            ).fetchone()
            if self.paused() or not w:
                return None
            occupied = {
                row[0] for row in self.db.execute("SELECT worker_id FROM jobs WHERE occupied=1")
            }
            available = [
                w["id"] for w in self.workers() if w["enabled"] and w["id"] not in occupied
            ]
            suspended = {
                (row["batch_id"], row["worker_id"])
                for row in self.db.execute("SELECT * FROM suspensions")
            }
            hold = self.db.execute(
                "SELECT MIN(priority) FROM jobs WHERE batch_id="
                "(SELECT batch_id FROM batch_edit) AND state='waiting'"
            ).fetchone()[0]
            for row in self.db.execute(
                """SELECT r.* FROM jobs r JOIN batches b ON b.id=r.batch_id
                    WHERE state='waiting' AND b.cancelled=0 AND (? IS NULL OR priority<?) AND NOT EXISTS
                    (SELECT 1 FROM suspensions s WHERE s.batch_id=r.batch_id AND s.worker_id=?)
                    ORDER BY priority,created,ordinal""",
                (hold, hold, worker),
            ).fetchall():
                eligible = set(json.loads(row["eligible"]))
                preferred = next(
                    (
                        key
                        for key in available
                        if key in eligible and (row["batch_id"], key) not in suspended
                    ),
                    None,
                )
                # Worker loops wake independently. Enforce preference in this
                # transaction so a lower node cannot win a scheduling race.
                if preferred != worker:
                    continue
                remote = str(uuid.uuid4())
                self.db.execute(
                    "UPDATE jobs SET state='preparing',occupied=1,worker_id=?,worker_url=?,remote_id=? WHERE id=?",
                    (worker, w["url"], remote, row["id"]),
                )
                self.event("slot_claimed", row["id"], {"worker": worker, "remote_id": remote})
                return self.job(row["id"])
        return None

    def begin_submit(self, job_id):
        with self.db:
            row = self.job(job_id)
            if not row or row["submit_intent"] or row["state"] != "preparing":
                return False
            if row["cancel_requested"]:
                self._terminal(row, "cancelled")
                return False
            self.db.execute(
                "UPDATE jobs SET state='outstanding',submit_intent=1,started=?,assets='[]',eligible='[]' WHERE id=?",
                (time.time(), job_id),
            )
            self.event(
                "submit_intent", job_id, {"remote_id": row["remote_id"], "worker": row["worker_id"]}
            )
            return True

    def submitted(self, job_id, status, answer):
        with self.db:
            row = self.job(job_id)
            if not row or row["state"] in TERMINAL:
                return
            if status == 200 and answer.get("prompt_id") == row["remote_id"]:
                self.db.execute(
                    "UPDATE jobs SET acknowledged=1,diagnostics=? WHERE id=?",
                    (canonical(answer.get("node_errors") or {}), job_id),
                )
                self.event("remote_accepted", job_id)
            elif status == 400:
                self._terminal(row, "failed", error=canonical(answer))
            else:
                self.db.execute(
                    "UPDATE jobs SET state='unknown',error=? WHERE id=?",
                    ("Submission acknowledgement unavailable; reconciling exact identity", job_id),
                )
                self.event("submission_uncertain", job_id)

    def _terminal(self, row, state, history=None, error=None):
        self.db.execute(
            "UPDATE jobs SET state=?,occupied=0,ended=?,history=?,error=?,collection_state=? WHERE id=?",
            (
                state,
                time.time(),
                canonical(history) if history else None,
                error,
                "pending" if history else "not_applicable",
                row["id"],
            ),
        )
        if state == "failed":
            self.db.execute(
                "INSERT OR IGNORE INTO suspensions VALUES(?,?)", (row["batch_id"], row["worker_id"])
            )
        self.event("terminal", row["id"], {"state": state})

    def finish(self, job_id, history):
        with self.db:
            row = self.job(job_id)
            if row["state"] in TERMINAL:
                return
            status = history.get("status", {})
            messages = status.get("messages", [])
            interrupted = any(m[0] == "execution_interrupted" for m in messages)
            state = (
                "cancelled"
                if interrupted
                else "succeeded"
                if status.get("status_str") == "success" and not row["diagnostics"]
                else "failed"
            )
            self._terminal(
                row,
                state,
                {"status": status, "outputs": history.get("outputs", {})},
                canonical(row["diagnostics"] or status) if state == "failed" else None,
            )

    def preparation_failed(self, job_id, error):
        with self.db:
            row = self.job(job_id)
            if not row or row["state"] in TERMINAL:
                return
            if row["submit_intent"]:
                raise Conflict("Cannot classify an uncertain submission as preparation failure")
            self._terminal(row, "failed", error=error)

    def observe(self, job_id, present, cancel_ack=False):
        with self.db:
            row = self.job(job_id)
            if not row or not row["occupied"]:
                return
            self.db.execute(
                "UPDATE jobs SET observed=MAX(observed,?),cancel_ack=MAX(cancel_ack,?) WHERE id=?",
                (present, cancel_ack, job_id),
            )
            if not present and (cancel_ack or row["cancel_ack"]):
                self._terminal(row, "cancelled")
            elif not present and (row["acknowledged"] or row["observed"]):
                self.db.execute(
                    "UPDATE jobs SET state='unknown',error=? WHERE id=?",
                    ("Worker no longer reports this job; outcome requires reconciliation", job_id),
                )

    def cancel_queued(self, batch_id=None, job_ids=None):
        """Cancel only unassigned work, serialized with claims on the ledger thread."""
        if batch_id is not None:
            identity(batch_id)
        wanted = None if job_ids is None else {identity(job_id) for job_id in job_ids}
        with self.db:
            rows = self.db.execute(
                "SELECT * FROM jobs WHERE state='waiting' AND worker_id IS NULL "
                "AND occupied=0 AND submit_intent=0 AND (? IS NULL OR batch_id=?)",
                (batch_id, batch_id),
            ).fetchall()
            for row in rows:
                if wanted is None or row["id"] in wanted:
                    self._cancel_job(row)
        return {"cancelled": sum(wanted is None or row["id"] in wanted for row in rows)}

    def reorder_batch(self, batch_id, before_batch_id):
        """Move a batch's unassigned jobs; claims and admissions use this same ledger thread."""
        identity(batch_id)
        if before_batch_id is not None:
            identity(before_batch_id)
        if batch_id == before_batch_id:
            raise ValueError("A batch cannot be moved before itself")
        with self.db:
            if self.edit_state():
                raise Conflict("Queue order is locked while a batch is being edited")
            self.db.execute("BEGIN IMMEDIATE")
            rows = self.db.execute(
                "SELECT id,batch_id FROM jobs WHERE state='waiting' AND worker_id IS NULL "
                "AND occupied=0 AND submit_intent=0 ORDER BY priority,created,ordinal"
            ).fetchall()
            grouped = {}
            for row in rows:
                grouped.setdefault(row["batch_id"], []).append(row["id"])
            if batch_id not in grouped or (
                before_batch_id is not None and before_batch_id not in grouped
            ):
                raise Conflict("The queue changed; a batch no longer has queued jobs. Try again.")
            order = [key for key in grouped if key != batch_id]
            index = len(order) if before_batch_id is None else order.index(before_batch_id)
            order.insert(index, batch_id)
            ordered_jobs = [job_id for key in order for job_id in grouped[key]]
            self.db.executemany(
                "UPDATE jobs SET priority=? WHERE id=?",
                [(index + 1, job_id) for index, job_id in enumerate(ordered_jobs)],
            )
            self.event(
                "batch_reordered", detail={"batch_id": batch_id, "before_batch_id": before_batch_id}
            )
        return {"batch_ids": order}

    def _cancel_job(self, row):
        edit = self.edit_state()
        if edit and row["batch_id"] == edit["batch_id"] and row["state"] == "waiting":
            raise Conflict("Discard the batch edit before cancelling its queued jobs")
        self.db.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (row["id"],))
        if not row["submit_intent"]:
            self._terminal(row, "cancelled")
        self.event("cancel_requested", row["id"])

    def cancel_all(self):
        """Cancel current Fleet work in one transaction, serialized with assignment."""
        with self.db:
            rows = self.db.execute(
                "SELECT * FROM jobs WHERE state NOT IN ('succeeded','failed','cancelled') "
                "AND cancel_requested=0 AND (state!='unknown' OR occupied=1)"
            ).fetchall()
            for row in rows:
                self._cancel_job(row)
        return {"cancelled": len(rows)}

    def cancel_active(self):
        """Cancel occupied Fleet slots, leaving waiting jobs available for dispatch."""
        with self.db:
            rows = self.db.execute(
                "SELECT * FROM jobs WHERE occupied=1 AND cancel_requested=0 "
                "AND state NOT IN ('succeeded','failed','cancelled')"
            ).fetchall()
            for row in rows:
                self._cancel_job(row)
        return {"cancelled": len(rows)}

    def cancel(self, job_ids=None, batch_id=None):
        with self.db:
            if batch_id is not None:
                identity(batch_id)
                self.db.execute("UPDATE batches SET cancelled=1 WHERE id=?", (batch_id,))
                job_ids = [
                    r[0]
                    for r in self.db.execute("SELECT id FROM jobs WHERE batch_id=?", (batch_id,))
                ]
            for job_id in job_ids or []:
                row = self.job(job_id)
                if row is None:
                    raise KeyError(job_id)
                if row["state"] in TERMINAL:
                    continue
                self._cancel_job(row)
        return {"cancelled": True}

    def collected(self, job_id, outputs=None, error=None):
        with self.db:
            self.db.execute(
                "UPDATE jobs SET outputs=?,collection_state=?,error=CASE WHEN state='succeeded' THEN ? ELSE COALESCE(?,error) END WHERE id=?",
                (
                    canonical(outputs) if outputs is not None else None,
                    "error" if error else "collected",
                    error,
                    error,
                    job_id,
                ),
            )
            self.event("collection_error" if error else "collected", job_id)

    def action(self, job_id, action):
        if action == "hide" and job_id in self.history:
            self._hide_history(job_id)
            return {"ok": True}
        with self.db:
            row = self.job(job_id)
            if row is None:
                raise KeyError(job_id)
            if action == "collect" and row["history"] and row["collection_state"] == "error":
                self.db.execute("UPDATE jobs SET collection_state='pending' WHERE id=?", (job_id,))
            elif action == "front" and row["state"] == "waiting":
                minimum = self.db.execute("SELECT MIN(priority) FROM jobs").fetchone()[0]
                self.db.execute("UPDATE jobs SET priority=? WHERE id=?", (minimum - 1, job_id))
            elif action == "hide" and row["state"] in TERMINAL:
                self.db.execute("UPDATE jobs SET hidden=1 WHERE id=?", (job_id,))
            else:
                raise Conflict("Action is not valid for this job's current state")
            self.event(action, job_id)
        return {"ok": True}

    def reenable(self, batch_id, worker):
        with self.db:
            self.db.execute(
                "DELETE FROM suspensions WHERE batch_id=? AND worker_id=?",
                (identity(batch_id), worker),
            )
            self.event("worker_reenabled", detail={"batch_id": batch_id, "worker": worker})

    def state(self):
        columns = "id,batch_id,ordinal,state,worker_id,remote_id,occupied,submit_intent,acknowledged,cancel_requested,created,started,ended,collection_state,error,hidden,retry_of"
        jobs = [dict(r) for r in self.db.execute(f"SELECT {columns},priority FROM jobs")]
        jobs.extend(
            {key: row[key] for key in (columns + ",priority").split(",")}
            for row in self.history.values()
            if not row["hidden"]
        )
        jobs.sort(key=lambda row: (row["priority"], row["created"], row["ordinal"]))
        for row in jobs:
            del row["priority"]
        counts = {
            row["batch_id"]: dict(row)
            for row in self.db.execute(
                "SELECT p.*,json_array_length(r.job_ids) AS total FROM batch_progress p "
                "JOIN batch_receipts r USING(batch_id)"
            )
        }
        for row in self.db.execute(
            "SELECT batch_id,state,count(*) AS n FROM jobs GROUP BY batch_id,state"
        ):
            key = {
                "succeeded": "completed",
                "failed": "failed",
                "cancelled": "cancelled",
                "unknown": "review",
            }.get(row["state"])
            if key:
                counts[row["batch_id"]][key] += row["n"]
        return {
            "edit": self.edit_state(),
            "paused": self.paused(),
            "workers": self.workers(),
            "jobs": jobs,
            "batch_counts": {
                key: {
                    field: value[field]
                    for field in ("total", "completed", "failed", "cancelled", "review")
                }
                for key, value in counts.items()
            },
            "batch_names": {
                key: row["name"]
                for key, row in counts.items()
                if isinstance(row["name"], str) and row["name"].strip()
            },
            "suspensions": [dict(r) for r in self.db.execute("SELECT * FROM suspensions")],
            "events": [
                dict(r) for r in self.db.execute("SELECT * FROM events ORDER BY seq DESC LIMIT 200")
            ],
        }

    def backup(self):
        """Export only ordered node configuration, never a copy of the job ledger."""
        directory = owned_directory(self.root / "backups")
        path = directory / (str(uuid.uuid4()) + ".json")
        nodes = [
            {"id": worker["id"], "url": worker["url"], "enabled": bool(worker["enabled"])}
            for worker in self.workers()
        ]
        payload = {"format": "comfyui-fleet-nodes", "version": 1, "nodes": nodes}
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(canonical(payload) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return {"filename": path.name, "nodes": len(nodes)}


class Store:
    """Async seam ensuring SQLite and fsync never block ComfyUI's event loop."""

    def __init__(self, root):
        self.root = root
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="fleet-ledger")
        self.ledger = None

    async def open(self):
        loop = asyncio.get_running_loop()
        try:
            self.ledger = await loop.run_in_executor(self.executor, Ledger, self.root)
        except BaseException:
            self.executor.shutdown(wait=True)
            raise

    async def call(self, method, *args):
        if self.ledger is None:
            raise RuntimeError("Fleet ledger is not open")
        return await asyncio.get_running_loop().run_in_executor(
            self.executor, getattr(self.ledger, method), *args
        )

    async def close(self):
        if self.ledger:
            await self.call("close")
            self.ledger = None
        self.executor.shutdown(wait=True)
