"""Disposable full-stack browser fixture. Only stock ComfyUI boundaries are simulated."""

import asyncio
import base64
import json
from pathlib import Path
import signal
import sqlite3
import struct
import sys
import tempfile

import aiohttp
from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fleet.artifacts import Artifacts, read_regular  # noqa: E402
from fleet.controller import Controller  # noqa: E402
from fleet.http import Routes  # noqa: E402
from fleet.store import Store  # noqa: E402
from fleet.worker import Remote  # noqa: E402


# ComfyUI wraps custom tabs in an auto-height mount inside its scrollable sidebar.
HTML = """<!doctype html><html><head><style>
body{margin:0;background:#171717;color:#eee;font-family:system-ui}
main{width:320px;height:100vh}aside{position:fixed;left:350px;top:20px}
.sidebar-content-container{height:100%;overflow-x:hidden;overflow-y:auto}
#notifications{position:fixed;right:16px;bottom:16px;width:280px}
#notifications article{padding:12px;margin-top:8px;background:#243c33;border-radius:8px}
#notifications strong,#notifications span{display:block}
</style></head><body><main><div class="sidebar-content-container"><div id="fleet-mount"></div></div></main><aside>
<label>Workflow <input id="workflow" value="Portraits.json"></label>
<label>Jobs <input id="count" type="number" value="4"></label>
<button id="run" data-testid="queue-button">Run</button></aside><section id="notifications" aria-label="Notifications"></section><script type="module">
import {app} from '/scripts/app.js';
import '/extensions/ComfyUI-Fleet/fleet.js';
document.querySelector('#run').onclick=async()=>{
 app.extensionManager.workflow.activeWorkflow.filename=document.querySelector('#workflow').value;
 await app.queuePrompt(0,Number(document.querySelector('#count').value));
};
</script></body></html>"""

APP = """window.nativeNotifications=[];
const clone=value=>JSON.parse(JSON.stringify(value));
const initialWorkflow={filename:'Portraits.json',activeState:{nodes:[],extra:{}}};
const workflowStore={activeWorkflow:initialWorkflow,openWorkflows:[initialWorkflow],
 async closeWorkflow(workflow){this.openWorkflows=this.openWorkflows.filter(item=>item!==workflow)}};
export const app={
 registerExtension(extension){extension.setup()},
 extensionManager:{workflow:workflowStore,
   toast:{add(options){
     window.nativeNotifications.push(options);
     const notice=document.createElement('article');notice.setAttribute('role','status');
     const summary=document.createElement('strong');summary.textContent=options.summary;
     const detail=document.createElement('span');detail.textContent=options.detail;
     notice.append(summary,detail);
     if(options.closable){
       const close=document.createElement('button');close.textContent='Close notification';
       close.onclick=()=>notice.remove();notice.append(close);
     }
     document.querySelector('#notifications').append(notice);
     if(options.life)setTimeout(()=>notice.remove(),options.life);
   }},
   registerSidebarTab(tab){tab.render(document.querySelector('#fleet-mount'))},
   unregisterSidebarTab(){document.querySelector('#fleet-mount').replaceChildren()}},
 rootGraph:{nodes:[],extra:{},serialize(){return {nodes:this.nodes,extra:this.extra}}},canvas:{draw(){}},
 async loadGraphData(graph,clean,view,name){
   workflowStore.activeWorkflow.activeState=clone(this.rootGraph.serialize());
   const workflow=name&&typeof name==='object'?name:workflowStore.openWorkflows.find(item=>item.filename===name)||{filename:name||'Unsaved Workflow.json'};
   const data=clone(graph);
   this.rootGraph.nodes=data.nodes;this.rootGraph.extra=data.extra||{};
   workflow.activeState=clone(data);
   if(!workflowStore.openWorkflows.includes(workflow))workflowStore.openWorkflows.push(workflow);
   workflowStore.activeWorkflow=workflow;
 },
 async graphToPrompt(){return {output:{'1':{class_type:'SaveImage',inputs:{filename_prefix:this.rootGraph.extra.prompt||'test'}}},workflow:this.rootGraph.serialize()}},
 async queuePrompt(){throw new Error('Native queue must be intercepted by Fleet')}
};
const toastMode=new URLSearchParams(location.search).get('toast');
if(toastMode==='missing')delete app.extensionManager.toast;
if(toastMode==='broken')app.extensionManager.toast.add=()=>{throw new Error('Host toast unavailable')};
"""

API = """export const api={fetchApi:(path,options)=>fetch(path,options),
 dispatchCustomEvent(){},interrupt(){},apiURL:path=>path};"""

IMAGE = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOkAAAAASUVORK5CYII="
)


async def serve(app):
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"


class Worker:
    def __init__(self):
        self.online = True
        self.pending = {"native-job": {}}
        self.history = {}
        self.cancelled = []
        self.submissions = []
        self.downloads = []
        self.download_status = {}
        self.sockets = set()
        self.allow_cancel = asyncio.Event()
        self.allow_cancel.set()

    async def handle(self, request):
        if not self.online:
            raise web.HTTPServiceUnavailable(text="Node is powered off")
        path = request.path
        if path == "/system_stats":
            answer = {
                "system": {"comfyui_version": "0.37.0", "ram_total": 64 * 1024**3},
                "devices": [
                    {"name": "NVIDIA GeForce RTX 3090", "type": "cuda", "vram_total": 24 * 1024**3}
                ],
            }
        elif path == "/object_info":
            answer = {"SaveImage": {"input": {"required": {}}}}
        elif path == "/prompt":
            data = await request.json()
            self.submissions.append(data["prompt_id"])
            self.pending[data["prompt_id"]] = data
            answer = {"prompt_id": data["prompt_id"]}
        elif path == "/queue":
            answer = {"queue_running": [[0, key] for key in self.pending], "queue_pending": []}
        elif path == "/view":
            status = self.download_status.get(request.query["filename"], 200)
            self.downloads.append({**request.query, "status": status})
            return web.Response(
                status=status, body=IMAGE if status == 200 else b"", content_type="image/png"
            )
        elif path == "/history":
            if request.method == "POST" and (await request.json()).get("clear"):
                self.history.clear()
            answer = self.history
        elif path.startswith("/history/"):
            key = request.match_info["path"].split("/")[-1]
            answer = {key: self.history[key]} if key in self.history else {}
        elif path.startswith("/api/jobs/") and path.endswith("/cancel"):
            key = path.split("/")[-2]
            self.cancelled.append(key)
            await self.allow_cancel.wait()
            self.pending.pop(key, None)
            answer = {"cancelled": True}
        elif path == "/ws":
            socket = web.WebSocketResponse()
            await socket.prepare(request)
            self.sockets.add(socket)
            try:
                async for _ in socket:
                    pass
            finally:
                self.sockets.discard(socket)
            return socket
        else:
            raise web.HTTPNotFound()
        return web.json_response(answer)

    async def emit(self, event):
        for socket in tuple(self.sockets):
            if event["type"] == "preview":
                metadata = json.dumps({**event["data"], "image_type": "image/png"}).encode()
                await socket.send_bytes(struct.pack(">II", 4, len(metadata)) + metadata + IMAGE)
            else:
                await socket.send_json(event)

    def complete(self, key, with_results=False, outputs=None):
        if key == "native-job" or key not in self.pending:
            raise web.HTTPConflict(text="No such active Fleet prompt")
        self.pending.pop(key)
        self.history[key] = {
            "status": {
                "status_str": "success",
                "completed": True,
                "messages": [["execution_success", {}]],
            },
            "outputs": outputs
            if outputs is not None
            else {"1": {"images": [{"filename": "result.png", "type": "output"}]}}
            if with_results
            else {},
        }


async def main(root, node_count):
    store = Store(root / "state")
    await store.open()
    runners, workers, configuration = [], {}, []
    for name in (f"node-{index + 1}" for index in range(node_count)):
        worker = Worker()
        app = web.Application()
        app.router.add_route("*", "/{path:.*}", worker.handle)
        runner, url = await serve(app)
        runners.append(runner)
        workers[name] = worker
        configuration.append({"id": name, "url": url, "enabled": True})
    await store.call("configure", configuration)
    roots = {kind: root / kind for kind in ("input", "output", "temp")}
    for path in roots.values():
        path.mkdir()
    native_history = {}

    def local_jobs(job_id=None):
        return native_history.get(job_id) if job_id else list(native_history.values())

    async with aiohttp.ClientSession(trust_env=False) as session:
        routes = Routes(lambda: control, local_jobs)
        control = Controller(
            store, Remote(session), Artifacts(root / "state", roots), routes.publish
        )
        app = web.Application()
        table = web.RouteTableDef()
        routes.register(table)
        app.add_routes(table)

        async def source(request):
            name = request.match_info["name"]
            if name not in (
                "fleet.js",
                "panel.js",
                "preparation.js",
                "progress.js",
                "editing.js",
                "details.js",
            ):
                raise web.HTTPNotFound()
            return web.FileResponse(Path(__file__).resolve().parents[1] / "web" / name)

        async def native(request):
            modules = {
                "app.js": APP,
                "api.js": API,
                "promotedWidgetControl.js": "export function applyPromotedWidgetControl(){}",
                "widgets.js": "export function addValueControlWidgets(){return [{beforeQueued(){},afterQueued(){}}]}",
            }
            return web.Response(
                text=modules[request.match_info["name"]], content_type="text/javascript"
            )

        async def index(request):
            return web.Response(text=HTML, content_type="text/html")

        async def fixture(request):
            nonlocal control, store
            if request.method == "POST":
                data = await request.json()
                if "nodes_online" in data:
                    for worker in workers.values():
                        worker.online = data["nodes_online"]
                        if not worker.online:
                            worker.pending.clear()
                            worker.history.clear()
                            for socket in tuple(worker.sockets):
                                await socket.close()
                if "native_history" in data:
                    native_history.update({job["id"]: job for job in data["native_history"]})
                if "event" in data:
                    await workers[data["worker"]].emit(data["event"])
                if "allow_cancel" in data:
                    for worker in workers.values():
                        (
                            worker.allow_cancel.set
                            if data["allow_cancel"]
                            else worker.allow_cancel.clear
                        )()
                if "complete" in data:
                    workers[data["worker"]].download_status.update(data.get("download_status", {}))
                    workers[data["worker"]].complete(
                        data["complete"], data.get("with_results", False), data.get("outputs")
                    )
                if data.get("restart"):
                    await control.stop()
                    await store.close()
                    store = Store(root / "state")
                    await store.open()
                    control = Controller(
                        store, Remote(session), Artifacts(root / "state", roots), routes.publish
                    )
                    await control.start()
            return web.json_response(
                {
                    name: {
                        "pending": list(worker.pending),
                        "cancelled": worker.cancelled,
                        "history": list(worker.history),
                    }
                    for name, worker in workers.items()
                }
            )

        async def storage(request):
            with sqlite3.connect(root / "state" / "fleet.sqlite") as db:
                counts = {
                    name: db.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
                    for name in ("jobs", "batch_progress", "batch_receipts", "events")
                }
            return web.json_response(counts)

        async def worker_requests(request):
            return web.json_response(
                {
                    name: {"submissions": worker.submissions, "downloads": worker.downloads}
                    for name, worker in workers.items()
                }
            )

        async def view(request):
            path = str(Path(request.query.get("subfolder", "")) / request.query["filename"])
            return web.Response(body=read_regular(roots["output"], path), content_type="image/png")

        async def history(request):
            data = await request.json()
            if data.get("clear"):
                native_history.clear()
            for job_id in data.get("delete", []):
                native_history.pop(job_id, None)
            return web.json_response({"ok": True})

        app.router.add_get("/", index)
        app.router.add_get("/extensions/ComfyUI-Fleet/{name}", source)
        app.router.add_get("/scripts/{name}", native)
        app.router.add_route("*", "/fixture", fixture)
        app.router.add_get("/fixture/storage", storage)
        app.router.add_get("/fixture/requests", worker_requests)
        app.router.add_get("/view", view)
        app.router.add_post("/history", history)
        app.router.add_post("/api/history", history)
        runner, url = await serve(app)
        runners.append(runner)
        await control.start()
        print(json.dumps({"url": url}), flush=True)
        done = asyncio.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            asyncio.get_running_loop().add_signal_handler(sig, done.set)
        try:
            await done.wait()
        finally:
            await control.stop()
            for runner in reversed(runners):
                await runner.cleanup()
    await store.close()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="fleet-e2e-") as directory:
        asyncio.run(main(Path(directory), int(sys.argv[1]) if len(sys.argv) > 1 else 2))
