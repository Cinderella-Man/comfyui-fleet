"""ComfyUI Fleet extension entry point. No workflow nodes or import-time network I/O."""

import asyncio
import importlib.metadata
import logging
import os
from pathlib import Path

import aiohttp
from aiohttp import web
import comfyui_version
import folder_paths
from comfy_execution.jobs import get_all_jobs, get_job
from server import PromptServer, _remove_sensitive_from_queue

from .fleet.artifacts import Artifacts
from .fleet.compatibility import controller_compatibility
from .fleet.controller import Controller
from .fleet.http import Routes
from .fleet.store import Store
from .fleet.worker import Remote, redirect_guard

NODE_CLASS_MAPPINGS = {}
WEB_DIRECTORY = "./web"
controller = None
startup_error = None


def ready():
    if controller is None:
        raise web.HTTPServiceUnavailable(text=startup_error or "Fleet is starting")
    return controller


def local_jobs(job_id=None):
    queue = PromptServer.instance.prompt_queue
    running, pending = queue.get_current_queue_volatile()
    running, pending = _remove_sensitive_from_queue(running), _remove_sensitive_from_queue(pending)
    history = queue.get_history(prompt_id=job_id) if job_id else queue.get_history()
    if job_id:
        return get_job(job_id, running, pending, history)
    return get_all_jobs(running, pending, history)[0]


routes = Routes(ready, local_jobs)
routes.register(PromptServer.instance.routes)


async def lifecycle(app):
    global controller, startup_error
    store = None
    try:
        version = importlib.metadata.version("comfyui-frontend-package")
        compatibility = controller_compatibility(comfyui_version.__version__, version)
        for warning in compatibility["warnings"]:
            logging.warning("%s", warning)
        root = Path(folder_paths.get_user_directory()) / "fleet"
        store = Store(root)
        await store.open()
        roots = {
            "input": folder_paths.get_input_directory(),
            "output": folder_paths.get_output_directory(),
            "temp": folder_paths.get_temp_directory(),
        }
        artifacts = await asyncio.to_thread(
            Artifacts, root, roots, output_layout=os.environ.get("FLEET_OUTPUT_LAYOUT", "job")
        )
        timeout = aiohttp.ClientTimeout(total=90, connect=3, sock_read=60)
        async with aiohttp.ClientSession(
            timeout=timeout,
            trust_env=False,
            connector=aiohttp.TCPConnector(limit=80),
            trace_configs=[redirect_guard()],
        ) as session:
            controller = Controller(
                store, Remote(session), artifacts, routes.publish, compatibility=compatibility
            )
            await controller.start()
            try:
                yield
            finally:
                await controller.stop()
    except Exception as exc:
        startup_error = "Fleet unavailable: " + type(exc).__name__ + ": " + str(exc)
        logging.error("%s", startup_error)
        # An incompatible plugin must not prevent ordinary ComfyUI from starting.
        if controller is None:
            yield
        else:
            raise
    finally:
        if store is not None:
            await store.close()
        controller = None


PromptServer.instance.app.cleanup_ctx.append(lifecycle)
