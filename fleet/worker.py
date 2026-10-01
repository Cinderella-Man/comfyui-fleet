"""Bounded stock-worker HTTP/WebSocket transport. No redirects, proxy, or remote code."""

import asyncio
import json
import time

import aiohttp

from .compatibility import require_core
from .validation import MAX_BODY, MAX_FILE, worker_url


def redirect_guard():
    """Public aiohttp tracing also covers the WebSocket handshake's HTTP request."""
    trace = aiohttp.TraceConfig()

    async def reject(session, context, params):
        raise aiohttp.ClientError("Fleet does not follow worker redirects")

    trace.on_request_redirect.append(reject)
    return trace


async def read_limited(stream, maximum):
    chunks = bytearray()
    async for chunk in stream.iter_chunked(65536):
        chunks.extend(chunk)
        if len(chunks) > maximum:
            raise ValueError("Worker response exceeded the configured transfer limit")
    return bytes(chunks)


def hardware_info(stats):
    """Keep only hardware identity and capacity, never system paths or launch arguments."""
    if not isinstance(stats, dict) or not isinstance(stats.get("system"), dict):
        raise ValueError("Worker did not return system information")

    def memory(value):
        return int(value) if type(value) in (int, float) and 0 < value <= 2**60 else None

    devices = []
    reported = stats.get("devices")
    for device in reported[:64] if isinstance(reported, list) else []:
        if not isinstance(device, dict):
            continue
        name, kind = device.get("name"), device.get("type")
        name = " ".join(name.split())[:200] if isinstance(name, str) else ""
        kind = kind.strip().lower()[:32] if isinstance(kind, str) else ""
        if name or kind:
            devices.append(
                {"name": name, "type": kind, "vram_total": memory(device.get("vram_total"))}
            )
    return {"devices": devices, "ram_total": memory(stats["system"].get("ram_total"))}


class Remote:
    def __init__(self, session):
        self.session = session
        self.capabilities = {}

    async def request(self, url, path, body=None):
        async with self.session.request(
            "GET" if body is None else "POST",
            worker_url(url) + path,
            json=body,
            allow_redirects=False,
        ) as response:
            raw = await read_limited(response.content, MAX_BODY)
            data = json.loads(raw)
            return response.status, data

    async def get(self, url, path):
        status, data = await self.request(url, path)
        if status != 200:
            raise ValueError(f"Worker GET {path.split('?')[0]} returned HTTP {status}")
        return data

    async def hardware(self, url):
        return hardware_info(await self.get(url, "/system_stats"))

    async def compatible(self, worker, graph, refresh=False):
        url = worker["url"]
        cached = self.capabilities.get(url)
        if refresh or cached is None or time.monotonic() - cached[0] > 60:
            stats = await self.get(url, "/system_stats")
            system = stats.get("system") if isinstance(stats, dict) else None
            require_core(system.get("comfyui_version") if isinstance(system, dict) else None)
            info = await self.get(url, "/object_info")
            # Compatibility only needs node names and enumerated input choices.
            choices = {}
            for name, spec in info.items():
                fields = {
                    **spec.get("input", {}).get("required", {}),
                    **spec.get("input", {}).get("optional", {}),
                }
                choices[name] = {
                    key: declaration[0]
                    for key, declaration in fields.items()
                    if isinstance(declaration, list)
                    and declaration
                    and isinstance(declaration[0], list)
                }
            self.capabilities[url] = (time.monotonic(), choices)
        info = self.capabilities[url][1]
        missing = []
        for node in graph.values():
            spec = info.get(node["class_type"])
            if spec is None:
                missing.append("node " + node["class_type"])
                continue
            for name, value in node["inputs"].items():
                choices = spec.get(name)
                # File inputs are transported, not required to exist before upload.
                if node["class_type"] in ("LoadImage", "LoadImageMask") and name == "image":
                    continue
                if isinstance(value, str) and choices is not None and value not in choices:
                    missing.append(node["class_type"] + "." + name + ": " + value)
        return missing

    def prune_capabilities(self, enrolled):
        now = time.monotonic()
        for url, (checked, _) in list(self.capabilities.items()):
            if url not in enrolled or now - checked > 60:
                del self.capabilities[url]

    async def upload(self, url, name, subfolder, data):
        form = aiohttp.FormData()
        form.add_field("image", data, filename=name, content_type="application/octet-stream")
        form.add_field("type", "input")
        form.add_field("subfolder", subfolder)
        form.add_field("overwrite", "false")
        async with self.session.post(
            worker_url(url) + "/upload/image", data=form, allow_redirects=False
        ) as response:
            raw = await read_limited(response.content, MAX_BODY)
            if response.status != 200:
                raise ValueError(f"Input upload failed: HTTP {response.status}")
            return json.loads(raw)

    async def download(self, url, ref):
        async with self.session.get(
            worker_url(url) + "/view", params=ref, allow_redirects=False
        ) as response:
            if response.status != 200:
                raise ValueError(f"Result download failed: HTTP {response.status}")
            return await read_limited(response.content, MAX_FILE)

    async def events(self, url, client_id, on_event):
        while True:
            try:
                async with self.session.ws_connect(
                    worker_url(url) + "/ws",
                    params={"clientId": client_id},
                    heartbeat=15,
                    max_msg_size=8 * 1024 * 1024,
                ) as ws:
                    async for message in ws:
                        event = None
                        try:
                            if message.type == aiohttp.WSMsgType.TEXT:
                                event = json.loads(message.data)
                                await on_event(event.get("type"), event.get("data", {}))
                        finally:
                            # Release delivered events and unused previews before
                            # waiting for another message or reconnecting.
                            del message, event
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, ValueError, OSError):
                await asyncio.sleep(2)
