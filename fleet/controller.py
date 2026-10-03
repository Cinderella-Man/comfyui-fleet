"""Coordinates admission, per-worker execution, observation, and independent collection."""

import asyncio
import time
import uuid

from .store import Conflict
from .validation import batch_digests, canonical, prepared_batch, workers_config

HARDWARE_POLL_SECONDS = 60
HARDWARE_TIMEOUT_SECONDS = 5

EXECUTION_EVENTS = frozenset(
    {
        "execution_start",
        "execution_cached",
        "executing",
        "progress",
        "progress_state",
        "execution_success",
        "execution_error",
        "execution_interrupted",
    }
)


class Controller:
    def __init__(self, store, remote, artifacts, publish_event, *, compatibility=None):
        self.store, self.remote, self.artifacts = store, remote, artifacts
        self.publish_event = publish_event
        self.compatibility = compatibility or {}
        self.tasks = {}
        self.socket_tasks = {}
        self.hardware_tasks = {}
        self.hardware = {}
        self.hardware_limit = asyncio.Semaphore(4)
        self.health = {}
        self.progress = {}
        self.clients = {}
        self.socket_urls = {}
        self.admission_lock = asyncio.Lock()
        self.preparing_assets = {}
        self.stopping = False
        self.fatal_error = None

    async def admit(self, body):
        body = prepared_batch(body)
        async with self.admission_lock:
            prior = await self.store.call("batch", body["batch_id"])
            if prior:
                if prior["digest"] not in batch_digests(body):
                    raise Conflict("Batch identity already belongs to different settings")
                return {**prior, "replayed": True}
            return await self._admit_prepared(body)

    async def save_edit(self, body):
        body = prepared_batch(body)
        async with self.admission_lock:
            prior = await self.store.call("edit_receipt", body)
            if prior:
                return prior
            previous = await self.store.call("prepare_edit", body)
            return await self._admit_prepared(body, previous)

    async def _admit_prepared(self, body, previous=None):
        if self.fatal_error:
            raise Conflict("Fleet storage is unavailable; dispatch and admission are stopped")
        workers = [w for w in await self.store.call("workers") if w["enabled"]]
        if not workers:
            raise ValueError(
                "Add and enable a node in Fleet, then click Done before running a workflow"
            )
        try:
            eligible, assets, errors = [], [], {}
            # Retry failed discovery on the next admission, not for every job.
            unavailable = set()
            for index, job in enumerate(body["jobs"]):
                selected = []
                for w in workers:
                    if w["id"] in unavailable:
                        continue
                    try:
                        missing = await self.remote.compatible(w, job["output"])
                        if missing:
                            errors[w["id"]] = "; ".join(missing[:8])
                        else:
                            selected.append(w["id"])
                    except (ValueError, OSError, TimeoutError) as exc:
                        errors[w["id"]] = str(exc)
                        unavailable.add(w["id"])
                    except Exception as exc:
                        errors[w["id"]] = type(exc).__name__
                        unavailable.add(w["id"])
                if not selected:
                    raise ValueError("No compatible worker: " + canonical(errors))
                eligible.append(selected)
                arguments = (
                    (job["output"],) if previous is None else (job["output"], previous[index])
                )
                snapshot = asyncio.create_task(
                    asyncio.to_thread(self.artifacts.snapshot, *arguments)
                )
                try:
                    assets.append(await asyncio.shield(snapshot))
                except asyncio.CancelledError:
                    # A thread cannot be cancelled. Keep the lock until it stops
                    # writing so cleanup cannot miss a late snapshot.
                    await asyncio.gather(snapshot, return_exceptions=True)
                    raise
            answer = await self.store.call(
                "admit" if previous is None else "commit_edit", body, assets, eligible
            )
            return {**answer, "excluded_workers": errors}
        finally:
            await self.cleanup_inputs()

    async def start(self):
        await self.maintain()
        self.supervisor = asyncio.create_task(self.supervise(), name="fleet-supervisor")
        self.collector = asyncio.create_task(self.collection_loop(), name="fleet-collection")
        self.cleaner = asyncio.create_task(self.maintenance_loop(), name="fleet-cleanup")

    async def stop(self):
        self.stopping = True
        tasks = [
            self.supervisor,
            self.collector,
            self.cleaner,
            *self.tasks.values(),
            *self.socket_tasks.values(),
            *self.hardware_tasks.values(),
        ]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        # Complete the last cleanup pass before closing the ledger, even if a
        # cancelled transfer prevented the periodic pass from running.
        await self.maintain()
        for mapping in (
            self.tasks,
            self.socket_tasks,
            self.hardware_tasks,
            self.hardware,
            self.health,
            self.progress,
            self.clients,
            self.socket_urls,
            self.preparing_assets,
        ):
            mapping.clear()
        self.remote.prune_capabilities(set())

    async def supervise(self):
        while True:
            try:
                workers = await self.store.call("workers")
                for worker in workers:
                    key = worker["id"]
                    if key not in self.tasks:
                        self.clients[key] = str(uuid.uuid5(uuid.UUID(self.artifacts.instance), key))
                        self.tasks[key] = asyncio.create_task(
                            self.worker_loop(key), name=f"fleet-worker-{key}"
                        )
                    if self.socket_urls.get(key) != worker["url"]:
                        old_tasks = [
                            mapping.pop(key)
                            for mapping in (self.socket_tasks, self.hardware_tasks)
                            if key in mapping
                        ]
                        for old in old_tasks:
                            old.cancel()
                        await asyncio.gather(*old_tasks, return_exceptions=True)
                        self.hardware.pop(key, None)
                        self.socket_urls[key] = worker["url"]
                        self.hardware_tasks[key] = asyncio.create_task(
                            self.hardware_loop(key, worker["url"]), name=f"fleet-hardware-{key}"
                        )
                        self.socket_tasks[key] = asyncio.create_task(
                            self.remote.events(
                                worker["url"],
                                self.clients[key],
                                lambda kind, data, w=key: self.on_event(w, kind, data),
                            ),
                            name=f"fleet-events-{key}",
                        )
                # Configuration prevents orphaning active work or collection retries.
                for key in set(self.tasks) - {w["id"] for w in workers}:
                    self.tasks.pop(key).cancel()
                    self.socket_tasks.pop(key).cancel()
                    self.hardware_tasks.pop(key).cancel()
                    self.hardware.pop(key, None)
                    self.socket_urls.pop(key, None)
                    self.health.pop(key, None)
                    self.clients.pop(key, None)
                for task in [*self.tasks.values(), self.collector, self.cleaner]:
                    if task.done() and not task.cancelled():
                        error = task.exception()
                        if error:
                            raise error
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.fatal_error = (
                    type(exc).__name__ + ": scheduler stopped; inspect storage and restart"
                )
                for task in self.tasks.values():
                    task.cancel()
                return
            await asyncio.sleep(0.5)

    async def hardware_loop(self, worker, url):
        """Discover idle and disabled nodes too, independently of dispatch and UI polling."""
        while True:
            try:
                async with self.hardware_limit, asyncio.timeout(HARDWARE_TIMEOUT_SECONDS):
                    info = await self.remote.hardware(url)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Optional metadata must never stop scheduling. Keep the last known identity.
                info = {**self.hardware.get(worker, {}), "available": False}
            else:
                info = {**info, "available": True}
            self.hardware[worker] = {**info, "url": url}
            await asyncio.sleep(HARDWARE_POLL_SECONDS)

    async def worker_loop(self, worker):
        while True:
            row = await self.store.call("claim", worker)
            if row:
                try:
                    if not row["submit_intent"]:
                        await self.submit(row)
                    else:
                        await self.observe(row)
                    self.health[worker] = {"reachable": True, "checked": time.time()}
                except asyncio.CancelledError:
                    raise
                except (OSError, TimeoutError, ValueError) as exc:
                    self.health[worker] = {
                        "reachable": False,
                        "error": str(exc)[:300],
                        "checked": time.time(),
                    }
                except Exception as exc:
                    # Network library errors are transport failures. Store errors must
                    # escape the loop and stop the supervisor, never silently retry writes.
                    if type(exc).__module__.startswith("aiohttp"):
                        self.health[worker] = {
                            "reachable": False,
                            "error": type(exc).__name__,
                            "checked": time.time(),
                        }
                    else:
                        raise
            await asyncio.sleep(0.35)

    async def submit(self, row):
        async with self.admission_lock:
            current = await self.store.call("job", row["id"])
            if not current or current["state"] != "preparing" or not current["occupied"]:
                return
            self.preparing_assets[row["id"]] = row["assets"]
        try:
            graph = await self.artifacts.prepare(row, self.remote)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.store.call(
                "preparation_failed",
                row["id"],
                "Input transfer: " + type(exc).__name__ + ": " + str(exc)[:300],
            )
            return
        finally:
            self.preparing_assets.pop(row["id"], None)
        if not await self.store.call("begin_submit", row["id"]):
            return
        try:
            status, answer = await self.remote.request(
                row["worker_url"],
                "/prompt",
                {
                    "prompt_id": row["remote_id"],
                    "client_id": self.clients[row["worker_id"]],
                    "prompt": graph,
                    "extra_data": {"extra_pnginfo": {"workflow": row["workflow"]}},
                },
            )
        except asyncio.CancelledError:
            raise  # Persisted intent survives; next process observes instead of resending.
        except Exception:
            status, answer = None, {}
        await self.store.call("submitted", row["id"], status, answer)

    async def observe(self, row):
        url, remote_id = row["worker_url"], row["remote_id"]
        history = await self.remote.get(url, "/history/" + remote_id)
        if history.get(remote_id):
            await self.store.call("finish", row["id"], history[remote_id])
            return
        cancel_ack = False
        if row["cancel_requested"]:
            status, answer = await self.remote.request(url, f"/api/jobs/{remote_id}/cancel", {})
            cancel_ack = status == 200 and answer.get("cancelled") is True
        queue = await self.remote.get(url, "/queue")
        present = any(
            item[1] == remote_id
            for kind in ("queue_running", "queue_pending")
            for item in queue[kind]
        )
        if not present:
            # Completion can race between the first history read and queue snapshot.
            history = await self.remote.get(url, "/history/" + remote_id)
            if history.get(remote_id):
                await self.store.call("finish", row["id"], history[remote_id])
                return
        await self.store.call("observe", row["id"], present, cancel_ack)

    async def collection_loop(self):
        while True:
            rows = await self.store.call("pending_collection")
            for row in rows:
                if row["history"] and row["collection_state"] == "pending":
                    try:
                        outputs = await self.artifacts.collect(row, self.remote)
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        await self.store.call(
                            "collected", row["id"], None, type(exc).__name__ + ": " + str(exc)[:300]
                        )
                    else:
                        await self.store.call("collected", row["id"], outputs)
                        del outputs
                del row
            if not rows:
                await asyncio.sleep(0.5)

    async def maintenance_loop(self):
        while True:
            await self.maintain()
            await asyncio.sleep(0.5)

    async def configure(self, workers):
        # A node must not disappear between admission's compatibility check and commit.
        workers = workers_config(workers)
        async with self.admission_lock:
            previous = {worker["id"]: worker for worker in await self.store.call("workers")}
            reenabled = [
                worker
                for worker in workers
                if worker["enabled"]
                and worker["id"] in previous
                and not previous[worker["id"]]["enabled"]
                and worker["url"] == previous[worker["id"]]["url"]
            ]
            waiting = await self.store.call("waiting_jobs") if reenabled else []
            verified = {}
            for worker in reenabled:
                candidates = [job for job in waiting if worker["id"] not in job["eligible"]]
                for index, job in enumerate(candidates):
                    try:
                        missing = await self.remote.compatible(
                            worker, job["graph"], refresh=index == 0
                        )
                    except Exception:
                        # A failed refresh must not fall back to stale cached capabilities.
                        break
                    if not missing:
                        verified.setdefault(job["id"], []).append(worker["id"])
            # Enable and extend eligibility together so a claim cannot skip the newly
            # compatible front batch while these network checks are in flight.
            return await self.store.call("configure", workers, verified)

    async def maintain(self):
        # Snapshot creation and deletion share this lock. In-flight uploads also hold
        # references, including when their job was cancelled during preparation.
        async with self.admission_lock:
            await self.cleanup_inputs()
            self.remote.prune_capabilities({w["url"] for w in await self.store.call("workers")})
        active = await self.store.call("active_ids")
        for key in set(self.progress) - active:
            del self.progress[key]

    async def cleanup_inputs(self):
        """Caller holds admission_lock; keep snapshots pinned by unfinished uploads."""
        keep = await self.store.call("prune")
        keep.update(
            asset["sha256"] for assets in self.preparing_assets.values() for asset in assets
        )
        cleanup = asyncio.create_task(asyncio.to_thread(self.artifacts.prune_inputs, keep))
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            # A deletion must finish before another admission can create snapshots.
            await cleanup
            raise

    async def owned_job(self, worker, remote_id):
        return await self.store.call("active_identity", worker, remote_id)

    async def release_unknown(self, job_id):
        row = await self.store.call("job", job_id)
        if row is None or row["state"] != "unknown":
            raise Conflict("Only unknown outcomes can be manually reconciled")
        await self.observe(row)
        row = await self.store.call("job", job_id)
        if row["state"] != "unknown":
            return {"resolved": row["state"]}
        queue = await self.remote.get(row["worker_url"], "/queue")
        if any(
            item[1] == row["remote_id"]
            for k in ("queue_running", "queue_pending")
            for item in queue[k]
        ):
            raise Conflict("The exact job is still queued or executing")
        await self.store.call("release_unknown", job_id)
        return {"released": True, "outcome": "unknown"}

    async def on_event(self, worker, kind, data):
        if kind not in EXECUTION_EVENTS or not isinstance(data, dict):
            return
        row = await self.owned_job(worker, data.get("prompt_id"))
        if not row:
            return
        detail = {**data, "prompt_id": row["id"]}
        if kind == "progress_state":
            detail["nodes"] = {
                key: {**value, "prompt_id": row["id"]}
                for key, value in data.get("nodes", {}).items()
            }
        snapshot = self.progress.setdefault(row["id"], {})
        snapshot[kind] = detail
        self.publish_event({"job_id": row["id"], "type": kind, "detail": detail})
        self.trim()

    def trim(self):
        while len(self.progress) > 64:
            del self.progress[next(iter(self.progress))]

    async def state(self):
        state = await self.store.call("state")
        return {
            **state,
            "ready": not self.fatal_error,
            "error": self.fatal_error,
            "health": self.health,
            "hardware": {
                worker["id"]: self.hardware[worker["id"]]
                for worker in state["workers"]
                if self.hardware.get(worker["id"], {}).get("url") == worker["url"]
            },
            "progress": self.progress,
            "version": "0.1.0",
            "instance_id": self.artifacts.instance,
            "compatibility": self.compatibility,
        }
