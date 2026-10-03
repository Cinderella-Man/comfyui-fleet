"""Controller routes. Only explicit node configuration can introduce endpoints."""

import asyncio
from functools import wraps
import json
from urllib.parse import urlsplit

from aiohttp import web
import aiohttp

from .jobs import job, merged_jobs
from .compatibility import require_core
from .store import Conflict
from .validation import MAX_BODY, identity, worker_url
from .worker import hardware_info, read_limited


def same_origin(request):
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        raise web.HTTPForbidden(text="Cross-site Fleet access rejected")
    origin = request.headers.get("Origin")
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme != request.scheme or parsed.netloc != request.host:
            raise web.HTTPForbidden(text="Cross-origin Fleet access rejected")


async def body(request):
    same_origin(request)
    if request.content_type != "application/json":
        raise web.HTTPUnsupportedMediaType(text="application/json required")
    return json.loads(await read_limited(request.content, MAX_BODY))


class Routes:
    def __init__(self, ready, local_jobs):
        self.ready, self.local_jobs = ready, local_jobs
        self.clients = set()

    def publish(self, event):
        for queue in tuple(self.clients):
            if queue.full():
                # Slow readers reconnect to an authoritative snapshot; never grow unbounded.
                queue.get_nowait()
            queue.put_nowait(event)

    def register(self, routes):
        handlers = [
            ("GET", "/state", self.state),
            ("POST", "/workers", self.workers),
            ("POST", "/workers/reorder", self.reorder_workers),
            ("POST", "/workers/check", self.check_worker),
            ("POST", "/pause", self.pause),
            ("POST", "/queue/cancel", self.cancel_queued),
            ("POST", "/queue/reorder", self.reorder_queue),
            ("POST", "/backup", self.backup),
            ("POST", "/batches", self.admit),
            ("POST", "/edit/begin", self.begin_edit),
            ("POST", "/edit/draft", self.save_draft),
            ("POST", "/edit/touch", self.touch_edit),
            ("POST", "/edit/release", self.release_edit_owner),
            ("POST", "/edit/discard", self.discard_edit),
            ("POST", "/edit/save", self.save_edit),
            ("GET", "/batches/{batch_id}", self.batch),
            ("POST", "/batches/{batch_id}/rename", self.rename_batch),
            ("POST", "/batches/{batch_id}/cancel", self.cancel_batch),
            ("POST", "/batches/{batch_id}/reenable", self.reenable),
            ("POST", "/jobs/cancel", self.cancel),
            ("POST", "/jobs/cancel-all", self.cancel_all),
            ("POST", "/jobs/cancel-active", self.cancel_active),
            ("POST", "/jobs/{job_id}/{action}", self.action),
            ("GET", "/jobs", self.jobs),
            ("GET", "/jobs/{job_id}", self.detail),
            ("GET", "/events", self.events),
        ]
        for method, path, handler in handlers:

            @wraps(handler)
            async def guarded(request, handler=handler):
                try:
                    same_origin(request)
                    return await handler(request)
                except Conflict as exc:
                    return web.json_response({"error": str(exc)}, status=409)
                except (ValueError, TypeError, FileNotFoundError) as exc:
                    return web.json_response({"error": str(exc)}, status=400)
                except KeyError as exc:
                    return web.json_response(
                        {"error": "Unknown or missing identity: " + str(exc)}, status=404
                    )

            routes.route(method, "/fleet" + path)(guarded)

    async def state(self, request):
        return web.json_response(await self.ready().state())

    async def workers(self, request):
        data = await body(request)
        return web.json_response(await self.ready().configure(data["workers"]))

    async def reorder_workers(self, request):
        data = await body(request)
        return web.json_response(
            await self.ready().store.call(
                "reorder_worker", data["worker_id"], data["before_worker_id"]
            )
        )

    async def check_worker(self, request):
        data = await body(request)
        try:
            url = worker_url(data.get("url", ""))
        except ValueError:
            raise ValueError(
                "Enter a private IP address and port, for example http://192.168.1.20:8188"
            ) from None
        try:
            async with asyncio.timeout(5):
                stats = await self.ready().remote.get(url, "/system_stats")
        except (aiohttp.ClientError, OSError, TimeoutError, ValueError):
            raise ValueError(
                "Could not connect. Check the address and make sure ComfyUI is running and reachable from this server."
            ) from None
        system = stats.get("system") if isinstance(stats, dict) else None
        version = system.get("comfyui_version") if isinstance(system, dict) else None
        if not version:
            raise ValueError(
                "This address did not return a ComfyUI server. Check the IP address and port."
            )
        require_core(version)
        return web.json_response(
            {
                "url": url,
                "version": version,
                "hardware": {**hardware_info(stats), "url": url, "available": True},
            }
        )

    async def pause(self, request):
        """Operator maintenance/recovery control; the sidebar cancels queued work."""
        data = await body(request)
        await self.ready().store.call("pause", data["paused"])
        return web.json_response({"paused": data["paused"]})

    async def backup(self, request):
        await body(request)
        return web.json_response(await self.ready().store.call("backup"))

    async def cancel_queued(self, request):
        data = await body(request)
        if not isinstance(data, dict) or data.keys() - {"batch_id", "job_ids"}:
            raise ValueError("Expected an optional batch_id or job_ids")
        if "batch_id" in data:
            identity(data["batch_id"])
        if "job_ids" in data and (
            not isinstance(data["job_ids"], list) or len(data["job_ids"]) > 1000
        ):
            raise ValueError("Expected up to 1000 job IDs")
        return web.json_response(
            await self.ready().store.call(
                "cancel_queued", data.get("batch_id"), data.get("job_ids")
            )
        )

    async def reorder_queue(self, request):
        data = await body(request)
        return web.json_response(
            await self.ready().store.call(
                "reorder_batch", data["batch_id"], data["before_batch_id"]
            )
        )

    async def admit(self, request):
        return web.json_response(await self.ready().admit(await body(request)))

    async def begin_edit(self, request):
        data = await body(request)
        return web.json_response(
            await self.ready().store.call("begin_edit", data["batch_id"], data["owner"])
        )

    async def save_draft(self, request):
        return web.json_response(await self.ready().store.call("save_draft", await body(request)))

    async def touch_edit(self, request):
        return web.json_response(await self.ready().store.call("touch_edit", await body(request)))

    async def release_edit_owner(self, request):
        return web.json_response(
            await self.ready().store.call("release_edit_owner", await body(request))
        )

    async def discard_edit(self, request):
        return web.json_response(await self.ready().store.call("discard_edit", await body(request)))

    async def save_edit(self, request):
        return web.json_response(await self.ready().save_edit(await body(request)))

    async def batch(self, request):
        result = await self.ready().store.call("batch", request.match_info["batch_id"])
        if result is None:
            raise web.HTTPNotFound()
        return web.json_response(result)

    async def rename_batch(self, request):
        data = await body(request)
        if not isinstance(data, dict) or data.keys() != {"name"}:
            raise ValueError("Expected a batch name")
        return web.json_response(
            await self.ready().store.call(
                "rename_batch", request.match_info["batch_id"], data["name"]
            )
        )

    async def cancel_batch(self, request):
        await body(request)
        return web.json_response(
            await self.ready().store.call("cancel", None, request.match_info["batch_id"])
        )

    async def cancel(self, request):
        data = await body(request)
        if not isinstance(data.get("job_ids"), list) or len(data["job_ids"]) > 1000:
            raise ValueError("Expected up to 1000 job IDs")
        return web.json_response(await self.ready().store.call("cancel", data["job_ids"]))

    async def cancel_all(self, request):
        await body(request)
        return web.json_response(await self.ready().store.call("cancel_all"))

    async def cancel_active(self, request):
        await body(request)
        return web.json_response(await self.ready().store.call("cancel_active"))

    async def action(self, request):
        await body(request)
        if request.match_info["action"] == "release":
            return web.json_response(
                await self.ready().release_unknown(request.match_info["job_id"])
            )
        return web.json_response(
            await self.ready().store.call(
                "action", request.match_info["job_id"], request.match_info["action"]
            )
        )

    async def reenable(self, request):
        data = await body(request)
        await self.ready().store.call("reenable", request.match_info["batch_id"], data["worker_id"])
        return web.json_response({"ok": True})

    async def jobs(self, request):
        return web.json_response(
            merged_jobs(await self.ready().store.call("jobs"), self.local_jobs(), request.query)
        )

    async def detail(self, request):
        job_id = request.match_info["job_id"]
        row = await self.ready().store.call("job", job_id)
        result = job(row, True) if row else self.local_jobs(job_id)
        if result is None:
            raise web.HTTPNotFound()
        return web.json_response(result)

    async def events(self, request):
        ws = web.WebSocketResponse(heartbeat=15, max_msg_size=1024)
        await ws.prepare(request)
        queue = asyncio.Queue(maxsize=128)
        self.clients.add(queue)

        async def send():
            while True:
                await ws.send_json(await queue.get())

        sender = asyncio.create_task(send())
        try:
            async for _ in ws:
                pass
        finally:
            self.clients.discard(queue)
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)
        return ws
