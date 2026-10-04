import asyncio
import json
import threading
import uuid
import weakref
from types import SimpleNamespace

import pytest

import aiohttp
from aiohttp import web

from fleet.artifacts import Artifacts
from fleet.controller import Controller
import fleet.controller as controller_module
from fleet.http import Routes
from fleet.store import Store
from fleet.worker import Remote, hardware_info, redirect_guard
import fleet.worker as worker_module
from test_ledger import batch, history


@pytest.mark.parametrize("receipt", ["acknowledged", "observed", "unconfirmed", "interrupted"])
@pytest.mark.parametrize("restart_controller", [False, True])
def test_returning_nodes_drop_missing_jobs_and_continue_queue(
    tmp_path, receipt, restart_controller
):
    async def scenario():
        store = Store(tmp_path / "state")
        await store.open()
        workers = ["a", "b", "c"]

        class ReturningNodes:
            online = False

            async def get(self, url, path):
                if not self.online:
                    raise OSError("Node is offline")
                if path.startswith("/history/"):
                    return {}
                assert path == "/queue"
                return {"queue_running": [], "queue_pending": []}

            async def request(self, *args):
                if args[1].startswith("/api/jobs/") and args[1].endswith("/cancel"):
                    return 200, {"cancelled": False}
                pytest.fail("Reconciliation must never resubmit the missing job")

        remote = ReturningNodes()
        try:
            await store.call(
                "configure",
                [
                    {"id": worker, "url": f"http://127.0.0.{index + 1}:8188"}
                    for index, worker in enumerate(workers)
                ],
            )
            value = batch(9)
            accepted = await store.call("admit", value, [[]] * 9, [workers] * 9)
            active = []
            for worker in workers:
                row = await store.call("claim", worker)
                await store.call("begin_submit", row["id"])
                if receipt == "interrupted":
                    # The controller stopped before recording the submission's
                    # outcome. Cancelling the missing remote identity returns false.
                    await store.call("cancel", [row["id"]])
                else:
                    await store.call(
                        "submitted",
                        row["id"],
                        200 if receipt == "acknowledged" else None,
                        {"prompt_id": row["remote_id"]} if receipt == "acknowledged" else {},
                    )
                if receipt == "observed":
                    await store.call("observe", row["id"], True)
                active.append(await store.call("job", row["id"]))
            waiting_ids = set(accepted["job_ids"]) - {row["id"] for row in active}
            if restart_controller:
                await store.close()
                store = Store(tmp_path / "state")
                await store.open()
            control = Controller(store, remote, None, lambda event: None)
            for row in active:
                with pytest.raises(OSError, match="offline"):
                    await control.observe(row)
                assert (await store.call("job", row["id"]))["occupied"] == 1
            assert {
                row["id"]
                for row in (await store.call("state"))["jobs"]
                if row["state"] == "waiting"
            } == waiting_ids

            remote.online = True
            for row in active:
                await control.observe(row)
                dropped = await store.call("job", row["id"])
                assert dropped["state"] == "cancelled"
                assert dropped["occupied"] == 0 and dropped["ended"] is not None
                assert dropped["collection_state"] == "not_applicable"
                assert not await store.call("begin_submit", row["id"])
                await store.call("finish", row["id"], history())
                assert await store.call("job", row["id"]) == dropped
            state = await store.call("state")
            assert state["suspensions"] == []
            assert state["batch_counts"][value["batch_id"]]["cancelled"] == 3
            assert {row["id"] for row in state["jobs"] if row["state"] == "waiting"} == waiting_ids
            for worker in workers:
                next_job = await store.call("claim", worker)
                assert next_job["id"] in waiting_ids
                waiting_ids.remove(next_job["id"])
            await store.call("prune")
            assert (await store.call("state"))["batch_counts"][value["batch_id"]]["cancelled"] == 3
        finally:
            await store.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "reported",
    [
        "running",
        "pending",
        "history",
        "history_race",
        "offline",
        "queue_error",
        "second_history_error",
    ],
)
def test_reconciliation_preserves_reported_jobs_and_waits_for_complete_checks(tmp_path, reported):
    async def scenario():
        store = Store(tmp_path / "state")
        await store.open()
        try:
            await store.call("configure", [{"id": "one", "url": "http://127.0.0.1:8188"}])
            await store.call("admit", batch(2), [[], []], [["one"], ["one"]])
            active = await store.call("claim", "one")
            await store.call("begin_submit", active["id"])
            await store.call("submitted", active["id"], None, {})

            class Reports:
                reads = 0

                async def get(self, url, path):
                    if reported == "offline":
                        raise OSError("Node is offline")
                    if path.startswith("/history/"):
                        self.reads += 1
                        if reported == "second_history_error" and self.reads == 2:
                            raise OSError("History check failed")
                        if reported == "history" or reported == "history_race" and self.reads == 2:
                            return {active["remote_id"]: history()}
                        return {}
                    assert path == "/queue"
                    if reported == "queue_error":
                        raise OSError("Queue check failed")
                    return {
                        "queue_running": [[0, active["remote_id"]]]
                        if reported == "running"
                        else [],
                        "queue_pending": [[0, active["remote_id"]]]
                        if reported == "pending"
                        else [],
                    }

            remote = Reports()
            control = Controller(store, remote, None, lambda event: None)
            if reported in {"offline", "queue_error", "second_history_error"}:
                with pytest.raises(OSError):
                    await control.observe(active)
            else:
                await control.observe(active)
            row = await store.call("job", active["id"])
            if reported in {"history", "history_race"}:
                assert row["state"] == "succeeded" and row["occupied"] == 0
                assert row["collection_state"] == "pending"
            else:
                assert row["occupied"] == 1
                assert row["state"] == (
                    "outstanding" if reported in {"running", "pending"} else "unknown"
                )
            assert (
                len(
                    [
                        job
                        for job in (await store.call("state"))["jobs"]
                        if job["state"] == "waiting"
                    ]
                )
                == 1
            )
            if reported == "history_race":
                assert remote.reads == 2
        finally:
            await store.close()

    asyncio.run(scenario())


def test_worker_releases_delivered_event_while_waiting_for_next_message(monkeypatch):
    async def scenario():
        waiting = asyncio.Event()
        references = []

        class Payload(dict):
            pass

        class Socket:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def __aiter__(self):
                yield SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data="event")
                waiting.set()
                await asyncio.Event().wait()

        def decode(raw):
            assert raw == "event"
            return {
                "type": "execution_error",
                "data": Payload(prompt_id="demo", current_inputs={"text": "landscaping"}),
            }

        async def receive(kind, data):
            assert kind == "execution_error"
            assert data["current_inputs"] == {"text": "landscaping"}
            references.append(weakref.ref(data))

        monkeypatch.setattr(worker_module, "json", SimpleNamespace(loads=decode))
        remote = Remote(SimpleNamespace(ws_connect=lambda *args, **kwargs: Socket()))
        task = asyncio.create_task(remote.events("http://127.0.0.1:8188", "demo", receive))
        try:
            await asyncio.wait_for(waiting.wait(), 2)
            assert len(references) == 1
            assert references[0]() is None
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


def test_cleanup_during_cancelled_input_upload_keeps_inflight_snapshots(tmp_path):
    async def scenario():
        roots = {kind: tmp_path / kind for kind in ("input", "output", "temp")}
        for path in roots.values():
            path.mkdir()
        (roots["input"] / "one.png").write_bytes(b"one")
        (roots["input"] / "two.png").write_bytes(b"two")
        artifacts = Artifacts(tmp_path / "state", roots)
        store = Store(tmp_path / "state")
        await store.open()
        uploading, release = asyncio.Event(), asyncio.Event()
        uploads = []

        class RemoteUpload(Remote):
            async def upload(self, url, name, subfolder, data):
                uploads.append(data)
                if len(uploads) == 1:
                    uploading.set()
                    await release.wait()
                return {"name": name, "subfolder": subfolder, "type": "input"}

            async def request(self, *args):
                pytest.fail("A job cancelled before submission must never reach /prompt")

        control = Controller(store, RemoteUpload(None), artifacts, lambda event: None)
        task = None
        try:
            await control.configure([{"id": "one", "url": "http://127.0.0.1:8188"}])
            value = batch(1)
            value["jobs"][0]["output"] = {
                str(i): {"class_type": "LoadImage", "inputs": {"image": name}}
                for i, name in enumerate(("one.png", "two.png"))
            }
            assets = artifacts.snapshot(value["jobs"][0]["output"])
            await store.call("admit", value, [assets], [["one"]])
            row = await store.call("claim", "one")
            task = asyncio.create_task(control.submit(row))
            await asyncio.wait_for(uploading.wait(), 2)
            await store.call("cancel", [row["id"]])
            await control.maintain()
            assert len(list(artifacts.blobs.iterdir())) == 2
            release.set()
            await task
            assert uploads == [b"one", b"two"]
            await control.maintain()
            assert list(artifacts.blobs.iterdir()) == []
            assert (roots["input"] / "one.png").read_bytes() == b"one"
            assert (await store.call("job", row["id"]))["state"] == "cancelled"
        finally:
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            await store.close()

    asyncio.run(scenario())


def test_batch_admission_skips_an_unavailable_node_until_the_next_batch(tmp_path):
    async def scenario():
        roots = {kind: tmp_path / kind for kind in ("input", "output", "temp")}
        for path in roots.values():
            path.mkdir()
        store = Store(tmp_path / "state")
        await store.open()
        retry_gate = asyncio.Event()
        failed = recovered = False

        async def capabilities(node, path):
            nonlocal failed
            if node == "offline" and not recovered:
                if failed:
                    await retry_gate.wait()
                failed = True
                return web.json_response({}, status=503)
            if path == "system_stats":
                return web.json_response({"system": {"comfyui_version": "0.37.0"}})
            return web.json_response({"SaveImage": {"input": {"required": {}}}})

        # Separate worker listeners, so their configured URLs remain stock endpoints.
        runners = []
        async with aiohttp.ClientSession() as session:

            async def serve_node(node):
                app = web.Application()

                async def handle(request):
                    return await capabilities(node, request.match_info["path"])

                app.router.add_get("/{path}", handle)
                runner, url = await server(app)
                runners.append(runner)
                return {"id": node, "url": url}

            workers = [await serve_node(node) for node in ("healthy", "offline")]
            control = Controller(
                store, Remote(session), Artifacts(tmp_path / "state", roots), lambda event: None
            )
            routes = web.RouteTableDef()
            Routes(lambda: control, lambda: []).register(routes)
            app = web.Application()
            app.add_routes(routes)
            runner, url = await server(app)
            try:
                async with session.post(
                    url + "/fleet/workers", json={"workers": workers}
                ) as response:
                    assert response.status == 200
                # Once a node has failed discovery, a hung retry must not block
                # the rest of this batch from reaching the healthy node.
                async with asyncio.timeout(2):
                    async with session.post(url + "/fleet/batches", json=batch(5)) as response:
                        assert response.status == 200, await response.text()
                        accepted = await response.json()
                assert len(accepted["job_ids"]) == 5
                assert "offline" in accepted["excluded_workers"]
                recovered = True
                async with session.post(url + "/fleet/batches", json=batch(1)) as response:
                    assert response.status == 200
                    assert (await response.json())["excluded_workers"] == {}
            finally:
                retry_gate.set()
                await runner.cleanup()
                for worker_runner in runners:
                    await worker_runner.cleanup()
                await store.close()

    asyncio.run(scenario())


def test_node_backup_exports_only_nodes_in_dispatch_order(tmp_path):
    async def scenario():
        store = Store(tmp_path / "state")
        await store.open()
        workers = [
            {"id": "first", "url": "http://127.0.0.1:8188", "enabled": True},
            {"id": "second", "url": "http://127.0.0.2:8188", "enabled": False},
        ]
        await store.call("configure", workers)
        await store.call("reorder_worker", "second", "first")
        value = batch(1)
        value["jobs"][0]["workflow"]["extra"] = {"private_test_marker": "synthetic job metadata"}
        await store.call("admit", value, [[]], [["first"]])
        await store.call("pause", True)
        control = Controller(store, None, None, lambda event: None)
        routes = web.RouteTableDef()
        Routes(lambda: control, lambda *args: []).register(routes)
        app = web.Application()
        app.add_routes(routes)
        runner, url = await server(app)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url + "/fleet/jobs") as response:
                    before = await response.json()
                async with session.post(url + "/fleet/backup", json={}) as response:
                    assert response.status == 200
                    result = await response.json()
                path = tmp_path / "state" / "backups" / result["filename"]
                assert path.suffix == ".json", "Node backups must not export the job database"
                assert json.loads(path.read_text()) == {
                    "format": "comfyui-fleet-nodes",
                    "version": 1,
                    "nodes": [workers[1], workers[0]],
                }
                assert path.stat().st_mode & 0o777 == 0o600
                async with session.get(url + "/fleet/jobs") as response:
                    assert await response.json() == before
        finally:
            await runner.cleanup()
            await store.close()

    asyncio.run(scenario())


def test_rejected_admission_removes_partial_input_snapshots(tmp_path):
    async def scenario():
        roots = {kind: tmp_path / kind for kind in ("input", "output", "temp")}
        for path in roots.values():
            path.mkdir()
        (roots["input"] / "one.png").write_bytes(b"synthetic input")
        artifacts = Artifacts(tmp_path / "state", roots)
        store = Store(tmp_path / "state")
        await store.open()

        class Compatible(Remote):
            async def compatible(self, *args):
                return []

        control = Controller(store, Compatible(None), artifacts, lambda event: None)
        try:
            await control.configure([{"id": "one", "url": "http://127.0.0.1:8188"}])
            value = batch(2)
            for item, name in zip(value["jobs"], ("one.png", "missing.png")):
                item["output"] = {"1": {"class_type": "LoadImage", "inputs": {"image": name}}}
            with pytest.raises(FileNotFoundError):
                await control.admit(value)
            assert list(artifacts.blobs.iterdir()) == []
            assert await store.call("jobs") == []
            assert (roots["input"] / "one.png").read_bytes() == b"synthetic input"
        finally:
            await store.close()

    asyncio.run(scenario())


def test_cancelled_admission_waits_for_snapshot_cleanup(tmp_path, monkeypatch):
    async def scenario():
        roots = {kind: tmp_path / kind for kind in ("input", "output", "temp")}
        for path in roots.values():
            path.mkdir()
        (roots["input"] / "one.png").write_bytes(b"synthetic input")
        artifacts = Artifacts(tmp_path / "state", roots)
        store = Store(tmp_path / "state")
        await store.open()
        entered, release = threading.Event(), threading.Event()
        snapshot = artifacts.snapshot

        def blocked_snapshot(graph):
            entered.set()
            assert release.wait(5)
            return snapshot(graph)

        monkeypatch.setattr(artifacts, "snapshot", blocked_snapshot)

        class Compatible(Remote):
            async def compatible(self, *args):
                return []

        control = Controller(store, Compatible(None), artifacts, lambda event: None)
        task = None
        try:
            await control.configure([{"id": "one", "url": "http://127.0.0.1:8188"}])
            value = batch(1)
            value["jobs"][0]["output"] = {
                "1": {"class_type": "LoadImage", "inputs": {"image": "one.png"}}
            }
            task = asyncio.create_task(control.admit(value))
            assert await asyncio.to_thread(entered.wait, 2)
            task.cancel()
            await asyncio.sleep(0.02)
            assert control.admission_lock.locked(), "Snapshot writing must finish before unlocking"
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert list(artifacts.blobs.iterdir()) == []
            assert await store.call("jobs") == []
        finally:
            release.set()
            if task:
                await asyncio.gather(task, return_exceptions=True)
            await store.close()

    asyncio.run(scenario())


def test_slow_collection_does_not_delay_unneeded_input_cleanup(tmp_path):
    async def scenario():
        roots = {kind: tmp_path / kind for kind in ("input", "output", "temp")}
        for path in roots.values():
            path.mkdir()
        (roots["input"] / "one.png").write_bytes(b"synthetic input")
        artifacts = Artifacts(tmp_path / "state", roots)
        store = Store(tmp_path / "state")
        await store.open()
        downloading = asyncio.Event()

        class SlowWorker(Remote):
            async def download(self, *args):
                downloading.set()
                await asyncio.Event().wait()

            async def events(self, *args):
                await asyncio.Event().wait()

            async def hardware(self, *args):
                return {}

        control = Controller(store, SlowWorker(None), artifacts, lambda event: None)
        started = False
        try:
            worker = {"id": "one", "url": "http://127.0.0.1:8188"}
            await control.configure([worker])
            await store.call("admit", batch(1), [[]], [["one"]])
            row = await store.call("claim", "one")
            await store.call("begin_submit", row["id"])
            finished = history()
            finished["outputs"] = {"1": {"images": [{"filename": "result.png"}]}}
            await store.call("finish", row["id"], finished)
            await control.configure([{**worker, "enabled": False}])
            await control.start()
            started = True
            await asyncio.wait_for(downloading.wait(), 2)
            value = batch(1)
            value["jobs"][0]["output"] = {
                "1": {"class_type": "LoadImage", "inputs": {"image": "one.png"}}
            }
            assets = artifacts.snapshot(value["jobs"][0]["output"])
            await store.call("admit", value, [assets], [["one"]])
            await store.call("cancel_queued")
            async with asyncio.timeout(2):
                while list(artifacts.blobs.iterdir()):
                    await asyncio.sleep(0.02)
            assert (await store.call("job", row["id"]))["collection_state"] == "pending"
            # A shutdown between periodic passes must not leave cancelled inputs behind.
            control.cleaner.cancel()
            await asyncio.gather(control.cleaner, return_exceptions=True)
            value["batch_id"] = str(uuid.uuid4())
            assets = artifacts.snapshot(value["jobs"][0]["output"])
            await store.call("admit", value, [assets], [["one"]])
            await store.call("cancel_queued")
            await control.stop()
            started = False
            assert list(artifacts.blobs.iterdir()) == []
            assert (await store.call("job", row["id"]))["collection_state"] == "pending"
        finally:
            if started:
                await control.stop()
            await store.close()

    asyncio.run(scenario())


def test_capabilities_keep_only_validation_data_and_expire(tmp_path, monkeypatch):
    async def scenario():
        now = 100.0
        monkeypatch.setattr(worker_module.time, "monotonic", lambda: now)

        class DescribedWorker(Remote):
            async def get(self, url, path):
                if path == "/system_stats":
                    return {"system": {"comfyui_version": "0.37.0"}}
                return {
                    "Example": {
                        "description": "unneeded-description",
                        "input": {
                            "required": {"model": [["model-a"], {"tooltip": "unneeded-tooltip"}]},
                            "optional": {"text": ["STRING", {"default": "unneeded-default"}]},
                        },
                    }
                }

        remote = DescribedWorker(None)
        url = "http://127.0.0.1:8188"
        graph = {"1": {"class_type": "Example", "inputs": {"model": "model-a"}}}
        assert await remote.compatible({"url": url}, graph) == []
        assert "unneeded-" not in repr(remote.capabilities)
        graph["1"]["inputs"]["model"] = "missing"
        assert await remote.compatible({"url": url}, graph) == ["Example.model: missing"]
        remote.prune_capabilities(set())
        assert remote.capabilities == {}, "Removed nodes need no cached model lists"
        await remote.compatible({"url": url}, graph)
        now += 61
        remote.prune_capabilities({url})
        assert remote.capabilities == {}, "Idle cache entries must actually expire"

    asyncio.run(scenario())


async def server(app):
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    return runner, f"http://127.0.0.1:{port}"


async def until(predicate, timeout=8):
    async with asyncio.timeout(timeout):
        while not await predicate():
            await asyncio.sleep(0.05)


def test_hardware_metadata_uses_only_reported_names_and_valid_capacities():
    stats = {
        "system": {"ram_total": 64 * 1024**3, "argv": ["private launch arguments"]},
        "devices": [
            {
                "name": "cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync",
                "type": "cuda",
                "vram_total": 24 * 1024**3,
                "vram_free": 10,
            },
            {
                "name": "cuda:1 AMD Radeon RX 7900 XTX : native",
                "type": "cuda",
                "vram_total": 24 * 1024**3,
            },
            {"name": "cpu", "type": "cpu", "vram_total": 64 * 1024**3},
            {"name": "mps", "type": "mps", "vram_total": -1},
            {"name": "Unknown capacity", "vram_total": float("inf")},
            {"type": "xpu", "vram_total": True},
            None,
            {},
        ],
    }
    result = hardware_info(stats)
    assert result == {
        "ram_total": 64 * 1024**3,
        "devices": [
            {
                "name": "cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync",
                "type": "cuda",
                "vram_total": 24 * 1024**3,
            },
            {
                "name": "cuda:1 AMD Radeon RX 7900 XTX : native",
                "type": "cuda",
                "vram_total": 24 * 1024**3,
            },
            {"name": "cpu", "type": "cpu", "vram_total": 64 * 1024**3},
            {"name": "mps", "type": "mps", "vram_total": None},
            {"name": "Unknown capacity", "type": "", "vram_total": None},
            {"name": "", "type": "xpu", "vram_total": None},
        ],
    }
    assert hardware_info({"system": {}}) == {"devices": [], "ram_total": None}
    assert hardware_info({"system": {"ram_total": "64GB"}, "devices": {}}) == {
        "devices": [],
        "ram_total": None,
    }
    for invalid in ([], None, {}, {"system": []}):
        with pytest.raises(ValueError, match="system information"):
            hardware_info(invalid)


def test_hardware_discovery_handles_idle_disabled_changed_and_removed_nodes(tmp_path, monkeypatch):
    async def scenario():
        hits = []
        runners, urls = [], []
        for name in ("NVIDIA GeForce RTX 3090", "AMD Radeon RX 7900 XTX"):
            app = web.Application()

            async def stats(request, name=name):
                hits.append(name)
                return web.json_response(
                    {
                        "system": {"ram_total": 64 * 1024**3},
                        "devices": [{"name": name, "type": "cuda", "vram_total": 24 * 1024**3}],
                    }
                )

            app.router.add_get("/system_stats", stats)
            runner, url = await server(app)
            runners.append(runner)
            urls.append(url)

        async def no_events(*args):
            await asyncio.Future()

        monkeypatch.setattr(Remote, "events", no_events)
        store = Store(tmp_path / "state")
        await store.open()
        await store.call(
            "configure",
            [{"id": "one", "url": urls[0]}, {"id": "two", "url": urls[1], "enabled": False}],
        )
        roots = {kind: tmp_path / kind for kind in ("input", "output", "temp")}
        for path in roots.values():
            path.mkdir()
        artifacts = Artifacts(tmp_path / "state", roots)
        try:
            async with aiohttp.ClientSession(trust_env=False) as session:
                control = Controller(store, Remote(session), artifacts, lambda event: None)
                await control.start()
                try:

                    async def discovered():
                        info = (await control.state())["hardware"]
                        return len(info) == 2 and all(v["available"] for v in info.values())

                    await until(discovered)
                    state = await control.state()
                    assert (
                        state["hardware"]["one"]["devices"][0]["name"] == "NVIDIA GeForce RTX 3090"
                    )
                    assert (
                        state["hardware"]["two"]["devices"][0]["name"] == "AMD Radeon RX 7900 XTX"
                    )
                    assert state["jobs"] == []
                    for _ in range(5):
                        await control.state()
                    assert len(hits) == 2, "Browser polls must use the cached metadata"
                    old_tasks = list(control.hardware_tasks.values())
                    await store.call("configure", [{"id": "one", "url": urls[1]}])
                    info = (await control.state())["hardware"]
                    assert "two" not in info
                    assert "one" not in info or info["one"]["url"] == urls[1]

                    async def changed():
                        info = (await control.state())["hardware"]
                        return (
                            info.get("one", {}).get("devices", [{}])[0].get("name")
                            == "AMD Radeon RX 7900 XTX"
                        )

                    await until(changed)
                    assert all(task.done() for task in old_tasks)
                    await store.call("configure", [])
                    assert (await control.state())["hardware"] == {}

                    async def retired():
                        return not control.hardware_tasks and not control.hardware

                    await until(retired)
                    assert (await control.state())["ready"]
                finally:
                    tasks = list(control.hardware_tasks.values())
                    await control.stop()
                    assert all(task.done() for task in tasks)
        finally:
            await store.close()
            for runner in runners:
                await runner.cleanup()

    asyncio.run(scenario())


def test_hardware_failure_and_timeout_keep_identity_and_recover(tmp_path, monkeypatch):
    monkeypatch.setattr(controller_module, "HARDWARE_POLL_SECONDS", 0.02)
    monkeypatch.setattr(controller_module, "HARDWARE_TIMEOUT_SECONDS", 0.05)

    async def scenario():
        mode = "ok"
        hits = 0
        release = asyncio.Event()
        app = web.Application()

        async def stats(request):
            nonlocal hits
            hits += 1
            if mode == "offline":
                raise web.HTTPServiceUnavailable()
            if mode == "hang":
                await release.wait()
            return web.json_response(
                {
                    "system": {"ram_total": 64 * 1024**3},
                    "devices": [
                        {
                            "name": "RTX 3090" if mode == "ok" else "RTX 4090",
                            "type": "cuda",
                            "vram_total": 24 * 1024**3,
                        }
                    ],
                }
            )

        app.router.add_get("/system_stats", stats)
        runner, url = await server(app)
        store = Store(tmp_path / "state")
        await store.open()
        await store.call("configure", [{"id": "one", "url": url, "enabled": False}])
        try:
            async with aiohttp.ClientSession(trust_env=False) as session:
                control = Controller(
                    store,
                    Remote(session),
                    SimpleNamespace(instance=str(uuid.uuid4())),
                    lambda event: None,
                )
                task = asyncio.create_task(control.hardware_loop("one", url))
                try:

                    async def available():
                        return control.hardware.get("one", {}).get("available") is True

                    await until(available)
                    mode = "offline"

                    async def unavailable():
                        return control.hardware.get("one", {}).get("available") is False

                    await until(unavailable)
                    state = await control.state()
                    assert state["ready"]
                    assert state["hardware"]["one"]["devices"][0]["name"] == "RTX 3090"
                    mode = "hang"
                    previous_hits = hits

                    async def retried():
                        return hits >= previous_hits + 2

                    await until(retried, timeout=2)
                    assert not task.done(), "A stalled endpoint must not block future checks"
                    mode = "recovered"
                    release.set()
                    await until(available)
                    assert control.hardware["one"]["devices"][0]["name"] == "RTX 4090"
                    assert (await control.state())["ready"]
                finally:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        finally:
            release.set()
            await runner.cleanup()
            await store.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("core_version", ["0.37.0", "0.38.0", "0.100.0"])
def test_actual_http_lost_ack_no_duplicate_and_foreign_queue_preserved(tmp_path, core_version):
    async def scenario():
        submitted, queued, histories, cancelled = [], {}, {}, []
        foreign = str(uuid.uuid4())
        queued[foreign] = [1, foreign, {}, {}, []]
        lose_response = True
        app = web.Application()

        async def stats(request):
            return web.json_response({"system": {"comfyui_version": core_version}})

        async def info(request):
            return web.json_response({"SaveImage": {"input": {"required": {}}}})

        async def prompt(request):
            nonlocal lose_response
            data = await request.json()
            submitted.append(data["prompt_id"])
            queued[data["prompt_id"]] = [2, data["prompt_id"], data["prompt"], {}, []]
            if lose_response:
                lose_response = False
                request.transport.close()
            return web.json_response({"prompt_id": data["prompt_id"], "node_errors": {}})

        async def queue(request):
            return web.json_response({"queue_running": [], "queue_pending": list(queued.values())})

        async def old(request):
            key = request.match_info["id"]
            return web.json_response({key: histories[key]} if key in histories else {})

        async def cancel(request):
            key = request.match_info["id"]
            cancelled.append(key)
            return web.json_response({"cancelled": queued.pop(key, None) is not None})

        app.add_routes(
            [
                web.get("/system_stats", stats),
                web.get("/object_info", info),
                web.post("/prompt", prompt),
                web.get("/queue", queue),
                web.get("/history/{id}", old),
                web.post("/api/jobs/{id}/cancel", cancel),
            ]
        )
        runner, url = await server(app)
        store = Store(tmp_path / "state")
        await store.open()
        await store.call("configure", [{"id": "one", "url": url}])
        roots = {k: tmp_path / k for k in ("input", "output", "temp")}
        for p in roots.values():
            p.mkdir()
        artifacts = Artifacts(tmp_path / "state", roots)
        try:
            async with aiohttp.ClientSession(trust_env=False) as session:
                control = Controller(store, Remote(session), artifacts, lambda event: None)
                # No GPU/WebSocket required for the protocol test; use the real worker loop.
                control.clients["one"] = str(uuid.uuid4())
                answer = await control.admit(batch(2))
                task = asyncio.create_task(control.worker_loop("one"))

                async def observed():
                    return (await store.call("job", answer["job_ids"][0]))["observed"] == 1

                await until(observed)
                assert len(submitted) == 1
                await store.call("cancel", [answer["job_ids"][0]])

                async def second():
                    return len(submitted) == 2

                await until(second)
                assert submitted[0] != submitted[1]
                assert foreign in queued and foreign not in cancelled
                # Crash/reopen with second submission outstanding: no second POST for it.
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await store.close()
                store = Store(tmp_path / "state")
                await store.open()
                control.store = store
                task = asyncio.create_task(control.worker_loop("one"))
                await asyncio.sleep(0.8)
                assert len(submitted) == 2
                histories[submitted[1]] = history()
                queued.pop(submitted[1])

                async def completed():
                    return (await store.call("job", answer["job_ids"][1]))["state"] == "succeeded"

                await until(completed)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                assert foreign in queued
        finally:
            await store.close()
            await runner.cleanup()

    asyncio.run(scenario())


def test_route_origin_guards_and_range_scanning_removed(tmp_path):
    async def scenario():
        store = Store(tmp_path / "state")
        await store.open()

        class Control:
            async def state(self):
                return await store.call("state")

            async def configure(self, workers):
                return await store.call("configure", workers)

        control = Control()
        control.store = store
        routes = web.RouteTableDef()
        Routes(lambda: control, lambda: []).register(routes)
        app = web.Application()
        app.add_routes(routes)
        runner, url = await server(app)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url + "/fleet/workers",
                    json={"workers": []},
                    headers={"Origin": "https://evil.example"},
                ) as r:
                    assert r.status == 403
                async with session.post(
                    url + "/fleet/workers",
                    data=json.dumps({"workers": []}),
                    headers={"Content-Type": "text/plain"},
                ) as r:
                    assert r.status == 415
                async with session.post(
                    url + "/fleet/workers",
                    json={"workers": [{"id": "one", "url": "http://169.254.169.254"}]},
                ) as r:
                    assert r.status == 400
                async with session.post(
                    url + "/fleet/workers",
                    json={"workers": [{"id": "one", "url": "http://127.0.0.1:8188"}]},
                ) as r:
                    assert r.status == 200
                async with session.post(
                    url + "/fleet/discover", json={"range": "192.168.0.0/16"}
                ) as r:
                    assert r.status == 404
                assert len(await store.call("workers")) == 1
        finally:
            await runner.cleanup()
            await store.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("core_version", ["0.37.0", "0.38.0", "0.100.0"])
def test_check_node_checks_only_the_requested_address_without_enrolling(tmp_path, core_version):
    async def scenario():
        store = Store(tmp_path / "state")
        await store.open()
        stats_value = {
            "system": {
                "comfyui_version": core_version,
                "ram_total": 64 * 1024**3,
                "argv": ["private launch arguments"],
                "python_version": "private path",
            },
            "devices": [
                {
                    "name": "cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync",
                    "type": "cuda",
                    "vram_total": 24 * 1024**3,
                    "vram_free": 10,
                }
            ],
        }
        hits = []
        worker = web.Application()

        async def stats(request):
            hits.append(request.path)
            return web.json_response(stats_value)

        worker.router.add_get("/system_stats", stats)
        worker_runner, worker_url = await server(worker)
        async with aiohttp.ClientSession(trust_env=False) as session:

            class Control:
                remote = Remote(session)

            routes = web.RouteTableDef()
            Routes(lambda: Control(), lambda: []).register(routes)
            app = web.Application()
            app.add_routes(routes)
            runner, url = await server(app)
            try:
                async with session.post(
                    url + "/fleet/workers/check", json={"url": worker_url}
                ) as response:
                    assert response.status == 200
                    assert await response.json() == {
                        "url": worker_url,
                        "version": core_version,
                        "hardware": {
                            "url": worker_url,
                            "available": True,
                            "ram_total": 64 * 1024**3,
                            "devices": [
                                {
                                    "name": "cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync",
                                    "type": "cuda",
                                    "vram_total": 24 * 1024**3,
                                }
                            ],
                        },
                    }
                assert hits == ["/system_stats"]
                assert await store.call("workers") == []
                assert (await store.call("state"))["events"] == []
                for address in [
                    "http://169.254.169.254",
                    "https://8.8.8.8",
                    "http://example.com",
                    worker_url + "/some-page",
                ]:
                    async with session.post(
                        url + "/fleet/workers/check", json={"url": address}
                    ) as response:
                        assert response.status == 400
                        assert "private IP" in (await response.json())["error"]
                async with session.post(
                    url + "/fleet/workers/check",
                    json={"url": worker_url},
                    headers={"Origin": "https://evil.example"},
                ) as response:
                    assert response.status == 403
                assert hits == ["/system_stats"], (
                    "Invalid or cross-origin requests must never contact a node"
                )
                # Hardware is optional: a stock server remains usable if it omits
                # device details or returns malformed optional values.
                for optional in (
                    {},
                    {
                        "devices": [None, {}, {"name": 123}],
                        "system": {"comfyui_version": core_version, "ram_total": "unknown"},
                    },
                ):
                    stats_value = {"system": {"comfyui_version": core_version}, **optional}
                    count = len(hits)
                    async with session.post(
                        url + "/fleet/workers/check", json={"url": worker_url}
                    ) as response:
                        assert response.status == 200
                        assert (await response.json())["hardware"] == {
                            "url": worker_url,
                            "available": True,
                            "devices": [],
                            "ram_total": None,
                        }
                    assert len(hits) == count + 1, "Reuse the connectivity response for hardware"
                assert await store.call("workers") == []
                stats_value = {"system": {"comfyui_version": "0.36.0"}}
                async with session.post(
                    url + "/fleet/workers/check", json={"url": worker_url}
                ) as response:
                    assert response.status == 400
                    assert "requires ComfyUI 0.37.0" in (await response.json())["error"]
                stats_value = []
                async with session.post(
                    url + "/fleet/workers/check", json={"url": worker_url}
                ) as response:
                    assert response.status == 400
                    assert "did not return a ComfyUI server" in (await response.json())["error"]
                await worker_runner.cleanup()
                async with session.post(
                    url + "/fleet/workers/check", json={"url": worker_url}
                ) as response:
                    assert response.status == 400
                    assert "Could not connect" in (await response.json())["error"]
            finally:
                await runner.cleanup()
                await worker_runner.cleanup()
                await store.close()

    asyncio.run(scenario())


def test_cancel_queue_route_rechecks_assignments_and_preserves_active_work(tmp_path):
    async def scenario():
        store = Store(tmp_path / "state")
        await store.open()
        await store.call("configure", [{"id": "one", "url": "http://127.0.0.1:8188"}])
        value = batch(3)
        accepted = await store.call("admit", value, [[], [], []], [["one"], ["one"], ["one"]])

        class Control:
            pass

        control = Control()
        control.store = store
        routes = web.RouteTableDef()
        Routes(lambda: control, lambda: []).register(routes)
        app = web.Application()
        app.add_routes(routes)
        runner, url = await server(app)
        try:
            # A job was assigned after the browser last saw all three waiting.
            assigned = await store.call("claim", "one")
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url + "/fleet/queue/cancel", json={}, headers={"Origin": "https://evil.example"}
                ) as response:
                    assert response.status == 403
                async with session.post(url + "/fleet/queue/cancel", json={}) as response:
                    assert response.status == 200
                    assert await response.json() == {"cancelled": 2}
                async with session.post(url + "/fleet/queue/cancel", json={}) as response:
                    assert await response.json() == {"cancelled": 0}
            assert await store.call("job", assigned["id"]) == assigned
            for job_id in accepted["job_ids"][1:]:
                assert (await store.call("job", job_id))["state"] == "cancelled"
            assert not (await store.call("state"))["paused"]
        finally:
            await runner.cleanup()
            await store.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("compatibility", ["compatible", "incompatible", "offline"])
def test_reenable_checks_queued_work_before_making_node_available(tmp_path, compatibility):
    async def scenario():
        store = Store(tmp_path / "state")
        await store.open()
        checking, release = asyncio.Event(), asyncio.Event()

        class Worker:
            async def compatible(self, worker, graph, refresh=False):
                if worker["id"] == "one":
                    checking.set()
                    await release.wait()
                    if compatibility == "offline" and refresh:
                        raise TimeoutError("Node unreachable")
                    if compatibility == "incompatible" or (
                        compatibility == "compatible" and not refresh
                    ):
                        return ["Missing workflow node"]
                return []

        control = Controller(
            store,
            Worker(),
            SimpleNamespace(
                instance=str(uuid.uuid4()),
                snapshot=lambda graph: [],
                prune_inputs=lambda keep: None,
            ),
            lambda event: None,
        )
        workers = [
            {"id": "one", "url": "http://127.0.0.1:8188", "enabled": False},
            {"id": "two", "url": "http://127.0.0.2:8188", "enabled": True},
        ]
        task = None
        try:
            await control.configure(workers)
            accepted = await control.admit(batch(2 if compatibility == "offline" else 1))
            workers[0]["enabled"] = True
            task = asyncio.create_task(control.configure(workers))
            await asyncio.wait_for(checking.wait(), 2)
            assert not (await store.call("workers"))[0]["enabled"]
            assert await store.call("claim", "one") is None
            release.set()
            await task
            assert (await store.call("workers"))[0]["enabled"]
            if compatibility == "compatible":
                claimed = await store.call("claim", "one")
            else:
                assert await store.call("claim", "one") is None
                claimed = await store.call("claim", "two")
            assert claimed["id"] == accepted["job_ids"][0]
        finally:
            release.set()
            if task:
                await asyncio.gather(task, return_exceptions=True)
            await store.close()

    asyncio.run(scenario())


def test_reenable_ignores_jobs_assigned_or_cancelled_during_compatibility_check(tmp_path):
    async def scenario():
        store = Store(tmp_path / "state")
        await store.open()
        checking, release = asyncio.Event(), asyncio.Event()

        class Worker:
            async def compatible(self, worker, graph, refresh=False):
                if worker["id"] == "one":
                    checking.set()
                    await release.wait()
                return []

        control = Controller(
            store,
            Worker(),
            SimpleNamespace(
                instance=str(uuid.uuid4()),
                snapshot=lambda graph: [],
                prune_inputs=lambda keep: None,
            ),
            lambda event: None,
        )
        workers = [
            {"id": "one", "url": "http://127.0.0.1:8188", "enabled": False},
            {"id": "two", "url": "http://127.0.0.2:8188", "enabled": True},
        ]
        task = None
        try:
            await control.configure(workers)
            accepted = await control.admit(batch(3))
            workers[0]["enabled"] = True
            task = asyncio.create_task(control.configure(workers))
            await asyncio.wait_for(checking.wait(), 2)
            first, second, third = accepted["job_ids"]
            assert (await store.call("claim", "two"))["id"] == first
            await store.call("begin_submit", first)
            await store.call("cancel", [second])
            original = [await store.call("job", job_id) for job_id in (first, second)]
            release.set()
            await task
            assert [await store.call("job", job_id) for job_id in (first, second)] == original
            assert (await store.call("claim", "one"))["id"] == third
        finally:
            release.set()
            if task:
                await asyncio.gather(task, return_exceptions=True)
            await store.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "outputs,expected",
    [
        (
            {"1": {"text": ["A landscaped garden"]}},
            {
                "outputs_count": 0,
                "previewable_outputs_count": 0,
                "preview_output": {
                    "content": "A landscaped garden",
                    "nodeId": "1",
                    "mediaType": "text",
                },
            },
        ),
        (
            {"1": {"text": ["x" * 1025]}},
            {
                "outputs_count": 0,
                "previewable_outputs_count": 0,
                "preview_output": {
                    "content": "x" * 1024,
                    "truncated": True,
                    "nodeId": "1",
                    "mediaType": "text",
                },
            },
        ),
        (
            {
                "1": {"text": [{"filename": "caption.txt", "type": "output"}]},
                "2": {"images": [{"filename": "preview.png", "type": "temp"}]},
                "3": {"images": [{"filename": "garden.png", "type": "output"}]},
            },
            {
                "outputs_count": 3,
                "previewable_outputs_count": 3,
                "preview_output": {
                    "filename": "garden.png",
                    "type": "output",
                    "nodeId": "3",
                    "mediaType": "images",
                },
            },
        ),
        (
            {"1": {"latent": [{"filename": "garden.latent", "type": "output"}]}},
            {"outputs_count": 1, "previewable_outputs_count": 0, "preview_output": None},
        ),
        (
            {
                "1": {
                    "gifs": [{"filename": "garden.mp4", "type": "output", "format": "video/mp4"}]
                },
                "2": {"files": [{"filename": "garden.glb"}, {"filename": "notes.txt"}]},
            },
            {
                "outputs_count": 3,
                "previewable_outputs_count": 3,
                "preview_output": {
                    "filename": "garden.mp4",
                    "type": "output",
                    "format": "video/mp4",
                    "nodeId": "1",
                    "mediaType": "gifs",
                },
            },
        ),
    ],
)
def test_job_api_uses_native_output_preview_semantics(tmp_path, outputs, expected):
    async def scenario():
        store = Store(tmp_path / "state")
        await store.open()
        await store.call("configure", [{"id": "one", "url": "http://127.0.0.1:8188"}])
        await store.call("admit", batch(1), [[]], [["one"]])
        row = await store.call("claim", "one")
        await store.call("finish", row["id"], {**history(), "outputs": outputs})
        await store.call("collected", row["id"], outputs)
        control = Controller(store, None, None, lambda event: None)
        routes = web.RouteTableDef()
        Routes(lambda: control, lambda *args: []).register(routes)
        app = web.Application()
        app.add_routes(routes)
        runner, url = await server(app)
        try:
            async with aiohttp.ClientSession() as session:
                for path in ("/fleet/jobs", "/fleet/jobs/" + row["id"]):
                    async with session.get(url + path) as response:
                        assert response.status == 200
                        result = await response.json()
                    item = result["jobs"][0] if path == "/fleet/jobs" else result
                    assert {key: item[key] for key in expected} == expected
        finally:
            await runner.cleanup()
            await store.close()

    asyncio.run(scenario())


def test_job_api_admission_state_progress_and_native_cancellation(tmp_path):
    async def scenario():
        store = Store(tmp_path / "state")
        await store.open()
        await store.call("configure", [{"id": "one", "url": "http://127.0.0.1:8188"}])

        class CompatibleWorker:
            async def compatible(self, worker, graph):
                return []

        events = []
        control = Controller(
            store,
            CompatibleWorker(),
            SimpleNamespace(
                instance=str(uuid.uuid4()),
                snapshot=lambda graph: [],
                prune_inputs=lambda keep: None,
            ),
            events.append,
        )
        routes = web.RouteTableDef()
        Routes(lambda: control, lambda: []).register(routes)
        app = web.Application()
        app.add_routes(routes)
        runner, url = await server(app)
        try:
            value = batch(2)
            async with aiohttp.ClientSession() as session:
                async with session.post(url + "/fleet/batches", json=value) as response:
                    assert response.status == 200
                    accepted = await response.json()
                assert accepted["accepted"] and len(accepted["job_ids"]) == 2
                first, second = accepted["job_ids"]
                async with session.get(url + "/fleet/jobs") as response:
                    assert {job["id"] for job in (await response.json())["jobs"]} == {first, second}
                async with session.get(url + f"/fleet/jobs/{first}") as response:
                    detail = await response.json()
                    assert detail["id"] == first
                    assert detail["workflow"]["prompt"] == value["jobs"][0]["output"]
                async with session.post(url + f"/fleet/jobs/{second}/front", json={}) as response:
                    assert response.status == 200
                active = await store.call("claim", "one")
                assert active["id"] == second
                await store.call("begin_submit", second)
                await control.on_event(
                    "one", "progress", {"prompt_id": active["remote_id"], "value": 1, "max": 3}
                )
                assert events == [
                    {
                        "job_id": second,
                        "type": "progress",
                        "detail": {"prompt_id": second, "value": 1, "max": 3},
                    }
                ]
                # ComfyUI's native exact-ID action still works through the renamed Fleet API.
                async with session.post(
                    url + "/fleet/jobs/cancel", json={"job_ids": [second]}
                ) as response:
                    assert response.status == 200
                async with session.get(url + "/fleet/state") as response:
                    state = await response.json()
                    jobs = {job["id"]: job for job in state["jobs"]}
                    assert jobs[second]["cancel_requested"] and jobs[second]["occupied"]
                    assert not jobs[first]["cancel_requested"]
                    assert state["events"][0]["job_id"] == second
                async with session.get(url + f"/fleet/batches/{value['batch_id']}") as response:
                    assert (await response.json())["job_ids"] == [first, second]
        finally:
            await runner.cleanup()
            await store.close()

    asyncio.run(scenario())


def test_batch_reordering_http_contract_and_stale_queue(tmp_path):
    async def scenario():
        store = Store(tmp_path / "state")
        await store.open()
        await store.call("configure", [{"id": "one", "url": "http://127.0.0.1:8188"}])
        first, second = batch(2), batch(1)
        for value in (first, second):
            await store.call(
                "admit", value, [[] for _ in value["jobs"]], [["one"] for _ in value["jobs"]]
            )
        control = SimpleNamespace(store=store)
        routes = web.RouteTableDef()
        Routes(lambda: control, lambda: []).register(routes)
        app = web.Application()
        app.add_routes(routes)
        runner, url = await server(app)
        try:
            move = {"batch_id": second["batch_id"], "before_batch_id": first["batch_id"]}
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url + "/fleet/queue/reorder",
                    json=move,
                    headers={"Origin": "https://evil.example"},
                ) as response:
                    assert response.status == 403
                async with session.post(url + "/fleet/queue/reorder", json=move) as response:
                    assert response.status == 200
                    assert (await response.json())["batch_ids"] == [
                        second["batch_id"],
                        first["batch_id"],
                    ]
                assigned = await store.call("claim", "one")
                assert assigned["batch_id"] == second["batch_id"]
                async with session.post(url + "/fleet/queue/reorder", json=move) as response:
                    assert response.status == 409
                    assert "queue changed" in (await response.json())["error"]
                async with session.post(
                    url + "/fleet/queue/reorder", json={**move, "batch_id": "invalid"}
                ) as response:
                    assert response.status == 400
                assert await store.call("job", assigned["id"]) == assigned
        finally:
            await runner.cleanup()
            await store.close()

    asyncio.run(scenario())


def test_cancel_everything_route_cancels_current_fleet_work_and_only_its_remote_identity(tmp_path):
    async def scenario():
        foreign = str(uuid.uuid4())
        queued = {foreign: [1, foreign, {}, {}, []]}
        cancelled = []
        worker = web.Application()

        async def queue(request):
            return web.json_response({"queue_running": list(queued.values()), "queue_pending": []})

        async def old(request):
            return web.json_response({})

        async def cancel(request):
            job_id = request.match_info["id"]
            cancelled.append(job_id)
            return web.json_response({"cancelled": queued.pop(job_id, None) is not None})

        worker.add_routes(
            [
                web.get("/queue", queue),
                web.get("/history/{id}", old),
                web.post("/api/jobs/{id}/cancel", cancel),
            ]
        )
        worker_runner, worker_url = await server(worker)
        store = Store(tmp_path / "state")
        await store.open()
        try:
            await store.call("configure", [{"id": "one", "url": worker_url}])
            await store.call("admit", batch(3), [[], [], []], [["one"]] * 3)
            # Assignment and another admission occurred since the browser's last snapshot.
            active = await store.call("claim", "one")
            await store.call("begin_submit", active["id"])
            queued[active["remote_id"]] = [2, active["remote_id"], {}, {}, []]
            await store.call("admit", batch(2), [[], []], [["one"]] * 2)
            async with aiohttp.ClientSession() as session:
                control = Controller(store, Remote(session), None, lambda event: None)
                routes = web.RouteTableDef()
                Routes(lambda: control, lambda: []).register(routes)
                app = web.Application()
                app.add_routes(routes)
                runner, url = await server(app)
                try:
                    before = await store.call("state")
                    async with session.post(
                        url + "/fleet/jobs/cancel-all",
                        json={},
                        headers={"Origin": "https://evil.example"},
                    ) as response:
                        assert response.status == 403
                    assert await store.call("state") == before
                    async with session.post(url + "/fleet/jobs/cancel-all", json={}) as response:
                        assert response.status == 200
                        assert await response.json() == {"cancelled": 5}
                    state = await store.call("state")
                    assert sum(row["state"] == "cancelled" for row in state["jobs"]) == 4
                    assert all(row["cancel_requested"] for row in state["jobs"])
                    assert not state["paused"]
                    pending = await store.call("job", active["id"])
                    assert pending["occupied"]
                    await control.observe(pending)
                    assert (await store.call("job", active["id"]))["state"] == "cancelled"
                    assert cancelled == [active["remote_id"]]
                    assert list(queued) == [foreign]
                    assert await store.call("claim", "one") is None
                    async with session.post(url + "/fleet/jobs/cancel-all", json={}) as response:
                        assert await response.json() == {"cancelled": 0}
                finally:
                    await runner.cleanup()
        finally:
            await store.close()
            await worker_runner.cleanup()

    asyncio.run(scenario())


def test_http_and_websocket_redirects_never_reach_the_target():
    async def scenario():
        hits = []
        target = web.Application()

        async def destination(request):
            hits.append(request.path)
            return web.json_response({})

        target.router.add_get("/{path:.*}", destination)
        target_runner, target_url = await server(target)
        redirect = web.Application()
        seen = asyncio.Event()

        async def location(request):
            seen.set()
            raise web.HTTPFound(target_url + "/unexpected")

        redirect.router.add_get("/{path:.*}", location)
        redirect_runner, url = await server(redirect)
        try:
            async with aiohttp.ClientSession(
                trace_configs=[redirect_guard()], trust_env=False
            ) as session:
                remote = Remote(session)
                try:
                    await remote.get(url, "/history")
                except ValueError:
                    pass
                else:
                    raise AssertionError("Redirect should fail")
                seen.clear()
                task = asyncio.create_task(remote.events(url, str(uuid.uuid4()), None))
                await asyncio.wait_for(seen.wait(), 2)
                await asyncio.sleep(0.05)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                assert hits == []
        finally:
            await redirect_runner.cleanup()
            await target_runner.cleanup()

    asyncio.run(scenario())
