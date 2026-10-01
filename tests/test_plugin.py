"""Exercise extension startup with real Fleet code and a minimal ComfyUI host."""

import asyncio
import importlib.metadata
import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import aiohttp
from aiohttp import web
import pytest

from test_http_controller import server


@pytest.fixture
def plugin(monkeypatch, tmp_path):
    host = SimpleNamespace(app=web.Application(), routes=web.RouteTableDef())
    modules = {
        "comfyui_version": {"__version__": "0.38.0"},
        "folder_paths": {
            f"get_{name}_directory": lambda name=name: str(tmp_path / name)
            for name in ("user", "input", "output", "temp")
        },
        "comfy_execution": {},
        "comfy_execution.jobs": {
            "get_all_jobs": lambda *args: ([], 0),
            "get_job": lambda *args: None,
        },
        "server": {
            "PromptServer": SimpleNamespace(instance=host),
            "_remove_sensitive_from_queue": lambda queue: queue,
        },
    }
    for name, values in modules.items():
        module = ModuleType(name)
        module.__dict__.update(values)
        monkeypatch.setitem(sys.modules, name, module)
    for name in ("input", "output", "temp"):
        (tmp_path / name).mkdir()
    monkeypatch.setattr(importlib.metadata, "version", lambda name: "1.53.6")
    path = Path(__file__).resolve().parents[1] / "__init__.py"
    spec = importlib.util.spec_from_file_location("fleet_test_plugin", path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    host.app.add_routes(host.routes)
    yield module, host
    for name in list(sys.modules):
        if name.startswith("fleet_test_plugin."):
            del sys.modules[name]


@pytest.mark.parametrize(
    "core,frontend",
    [("0.37.0", "1.52.7"), ("0.37.4", "1.52.8"), ("0.38.0", "1.53.6"), ("0.100.0", "1.100.0")],
)
def test_controller_starts_on_baseline_and_newer_versions(
    plugin, monkeypatch, caplog, core, frontend
):
    module, host = plugin
    monkeypatch.setattr(module.comfyui_version, "__version__", core)
    monkeypatch.setattr(importlib.metadata, "version", lambda name: frontend)

    async def scenario():
        runner, url = await server(host.app)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url + "/fleet/state") as response:
                    assert response.status == 200, await response.text()
                    state = await response.json()
                    assert state["ready"] is True
                    assert state["compatibility"]["core"] == core
                    assert state["compatibility"]["frontend"] == frontend
                    warnings = state["compatibility"]["warnings"]
                    assert bool(warnings) == ((core, frontend) != ("0.37.0", "1.52.7"))
                    for warning in warnings:
                        assert warning in caplog.text
        finally:
            await runner.cleanup()
        assert module.controller is None

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "core,frontend,reason",
    [
        ("0.36.0", "1.53.6", "ComfyUI 0.36.0"),
        ("0.38.0", "1.52.6", "frontend 1.52.6"),
        ("0.37.0rc1", "1.53.6", "ComfyUI 0.37.0rc1"),
        ("unknown", "1.53.6", "version"),
    ],
)
def test_unsupported_versions_leave_comfyui_running(plugin, monkeypatch, core, frontend, reason):
    module, host = plugin
    monkeypatch.setattr(module.comfyui_version, "__version__", core)
    monkeypatch.setattr(importlib.metadata, "version", lambda name: frontend)

    async def ordinary_host_route(request):
        return web.json_response({"ok": True})

    host.app.router.add_get("/host", ordinary_host_route)

    async def scenario():
        runner, url = await server(host.app)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url + "/fleet/state") as response:
                    assert response.status == 503
                    message = await response.text()
                    assert reason in message
                    assert "or newer" in message
                async with session.get(url + "/host") as response:
                    assert response.status == 200
        finally:
            await runner.cleanup()

    asyncio.run(scenario())
