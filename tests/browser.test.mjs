// Browser regression tests at the visible Fleet setup / HTTP API boundary.
// The API fixture uses disposable in-memory state; it never contacts a rig.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FLEET_PLAYWRIGHT_MODULE || "playwright");

async function confirmCancellation(page) {
  await page.getByRole("dialog").getByRole("button",{name:/^Cancel /}).click();
}

async function setup(t, { workers = [], jobs = [], suspensions = [], hardware = {}, checkedHardware = {}, batchNames = {}, clock = false } = {}) {
  const held = new Map(), failures = new Map();
  const checks = [];
  const cancellations = [], jobActions = [], reorders = [];
  const state = { instance_id: randomUUID(), ready: true, paused: false,
    workers, jobs, batch_names: batchNames, suspensions, hardware, health: {}, progress: {} };
  const html = `<!doctype html><html><head><style>
    body{margin:0;background:#171717;color:#eee}main{height:100vh;width:320px}
    </style></head><body><main></main><script type="module">
    import { FleetPanel } from '/panel.js';
    const request = async (path, data) => {
      const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    };
    const panel = new FleetPanel({
      checkWorker: url => request('/fleet/workers/check', {url}),
      configure: async workers => {const result=await request('/fleet/workers', {workers});await refresh();return result},
      retry: refresh,
      reorderBatch: async (batch_id, before_batch_id) => {const result=await request('/fleet/queue/reorder', {batch_id,before_batch_id});await refresh();return result},
      cancelQueued: async () => {const result=await request('/fleet/queue/cancel', {});await refresh();return result},
      cancelActive: async () => {const result=await request('/fleet/jobs/cancel-active', {});await refresh();return result},
      jobAction: async (id, action) => {await request('/fleet/jobs/'+id+'/'+action, {});await refresh()},
      select: id => panel.render(panel.state, id),
    });
    document.querySelector('main').append(panel.root);
    async function refresh() {panel.render(await (await fetch('/fleet/state')).json(), null)}
    await refresh();setInterval(refresh,100);
    </script></body></html>`;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/panel.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end(readFileSync(new URL("../web/panel.js", import.meta.url)));
    }
    if (req.url === "/fleet/state") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(state));
    }
    if (req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/fleet/workers/check") {
        checks.push(body.url);
        const gate = held.get(body.url);
        if (gate) { gate.received(); await gate.promise; }
        if (failures.has(body.url)) {
          res.statusCode = 400;return res.end(JSON.stringify({error: failures.get(body.url)}));
        }
        const result = { url: body.url, version: "0.37.0" };
        if (checkedHardware[body.url] !== null) result.hardware = {
          devices: [], ram_total: null, ...checkedHardware[body.url], url: body.url, available: true,
        };
        return res.end(JSON.stringify(result));
      }
      if (req.url === "/fleet/workers") {
        const gate = held.get("configuration");
        if (gate) { gate.received(); await gate.promise; }
        if (failures.has("configuration")) {
          res.statusCode = 409;return res.end(JSON.stringify({error: failures.get("configuration")}));
        }
        state.workers = body.workers;
        return res.end(JSON.stringify(state.workers));
      }
      if (req.url === "/fleet/queue/cancel") {
        cancellations.push({path:req.url,body});
        if (failures.has("queue")) {
          res.statusCode = 500;return res.end(JSON.stringify({error: failures.get("queue")}));
        }
        let cancelled = 0;
        for (const job of state.jobs) {
          if (job.state !== "waiting" || job.worker_id || job.occupied || job.submit_intent) continue;
          job.state = "cancelled";job.cancel_requested = 1;job.collection_state = "not_applicable";cancelled++;
        }
        return res.end(JSON.stringify({cancelled}));
      }
      if (req.url === "/fleet/jobs/cancel-active") {
        cancellations.push({path:req.url,body});
        const gate = held.get("cancel-active");
        if (gate) {gate.received();await gate.promise;}
        if (failures.has("cancel-active")) {
          res.statusCode = 500;return res.end(JSON.stringify({error:failures.get("cancel-active")}));
        }
        let cancelled = 0;
        for (const job of state.jobs) {
          if (["succeeded","failed","cancelled"].includes(job.state) || job.cancel_requested ||
              !job.occupied) continue;
          job.cancel_requested = 1;cancelled++;
          if (!job.submit_intent) {job.state="cancelled";job.occupied=0;job.collection_state="not_applicable";}
        }
        return res.end(JSON.stringify({cancelled}));
      }
      const recovery = req.url.match(/^\/fleet\/jobs\/([^/]+)\/(release|collect)$/);
      if (recovery) {
        jobActions.push({id:recovery[1],action:recovery[2]});
        return res.end(JSON.stringify({ok:true}));
      }
      if (req.url === "/fleet/queue/reorder") {
        reorders.push(body);
        const gate = held.get("reorder");
        if (gate) {gate.received();await gate.promise;}
        if (failures.has("reorder")) {res.statusCode=500;return res.end(JSON.stringify({error:failures.get("reorder")}));}
        const waiting=state.jobs.filter(job=>job.state==="waiting" && !job.worker_id && !job.occupied && !job.submit_intent);
        const order=[...new Set(waiting.map(job=>job.batch_id))];
        if (!order.includes(body.batch_id) || (body.before_batch_id!=null && !order.includes(body.before_batch_id))) {
          res.statusCode=409;return res.end(JSON.stringify({error:"The queue changed; a batch no longer has queued jobs. Try again."}));
        }
        order.splice(order.indexOf(body.batch_id),1);
        order.splice(body.before_batch_id==null ? order.length : order.indexOf(body.before_batch_id),0,body.batch_id);
        state.jobs=[...state.jobs.filter(job=>!waiting.includes(job)),...order.flatMap(id=>waiting.filter(job=>job.batch_id===id))];
        return res.end(JSON.stringify({batch_ids:order}));
      }
    }
    res.setHeader("Content-Type", "text/html");res.end(html);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 340, height: 1050 } });
  if (clock) await page.clock.install({time:new Date("2026-09-30T10:00:00Z")});
  page.setDefaultTimeout(5000);
  const errors = [];page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    for (const gate of held.values()) gate.release();
    await browser.close();server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, [], "Browser must not throw uncaught errors");
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  if (workers.length) await page.getByRole("button", { name: "Manage nodes", exact: true }).waitFor();
  else await page.getByText("Add your first node", { exact: true }).waitFor();
  if (clock) await page.clock.pauseAt(new Date("2026-09-30T11:00:00Z"));
  return { page,
    checks: () => [...checks],
    cancellations: () => [...cancellations],
    jobActions: () => [...jobActions],
    reorders: () => [...reorders],
    failOrder: error => error ? failures.set("reorder", error) : failures.delete("reorder"),
    holdOrder: () => {
      let release, received;
      const promise = new Promise(resolve => {release=resolve});
      const seen = new Promise(resolve => {received=resolve});
      held.set("reorder", {promise,release,received});
      return {received:seen,release};
    },
    updateHardware: hardware => {state.hardware = hardware},
    updateJobs: jobs => {state.jobs = jobs},
    failQueue: error => error ? failures.set("queue", error) : failures.delete("queue"),
    failCancelActive: error => error ? failures.set("cancel-active", error) : failures.delete("cancel-active"),
    holdCancelActive: () => {
      let release, received;
      const promise = new Promise(resolve => {release=resolve});
      const seen = new Promise(resolve => {received=resolve});
      held.set("cancel-active", {promise,release,received});
      return {received:seen,release};
    },
    failAddress: (url, error) => error ? failures.set(url, error) : failures.delete(url),
    failConfiguration: error => error ? failures.set("configuration", error) : failures.delete("configuration"),
    holdConfiguration: () => {
      let release, received;
      const promise = new Promise(resolve => { release = resolve; });
      const seen = new Promise(resolve => { received = resolve; });
      held.set("configuration", { promise, release, received });
      return { received: seen, release };
    },
    holdAddress: url => {
      let release, received;
      const promise = new Promise(resolve => { release = resolve; });
      const seen = new Promise(resolve => { received = resolve; });
      held.set(url, { promise, release, received });
      return { received: seen, release: async () => {
        const response = page.waitForResponse(response => response.url().endsWith("/fleet/workers/check") && response.request().postDataJSON().url === url);
        release();await (await response).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      } };
    },
    state: async () => (await fetch(`http://127.0.0.1:${server.address().port}/fleet/state`)).json(),
    address: page.getByRole("textbox", { name: "ComfyUI address", exact: true }),
    name: page.getByRole("textbox", { name: "Name (optional)", exact: true }),
    add: page.getByRole("button", { name: "Add node", exact: true }),
    done: page.getByRole("button", { name: "Done", exact: true }),
  };
}

function fixtureJob(ordinal, changes = {}) {
  return { id: randomUUID(), batch_id: "test-batch", ordinal, created: 1780000000,
    state: "waiting", worker_id: null, occupied: 0, submit_intent: 0, cancel_requested: 0,
    collection_state: "pending", ...changes };
}

function gpuHardware(name = "NVIDIA GeForce RTX 3090", vram = 24, ram = 64) {
  return {devices:[{name:`cuda:0 ${name} : cudaMallocAsync`,type:"cuda",vram_total:vram * 1024 ** 3}],ram_total:ram * 1024 ** 3};
}

test("GPU names prefill without blur, survive refresh, and stay unique even when Add precedes the response", { timeout: 30000 }, async t => {
  const first = "http://192.168.1.20:8188", second = "http://192.168.1.21:8188";
  const {page,address,name,add,done,state,holdAddress} = await setup(t, {checkedHardware:{[first]:gpuHardware(),[second]:gpuHardware()}});
  await address.fill(first);
  await page.getByTitle("Connection verified", {exact:true}).waitFor();
  assert.equal(await name.inputValue(),"NVIDIA GeForce RTX 3090");
  assert.equal(await address.evaluate(el=>el===document.activeElement),true);
  await page.reload();await address.waitFor();
  assert.equal(await name.inputValue(),"NVIDIA GeForce RTX 3090");
  await add.click();await page.locator(".fleet-node-copy").getByText("NVIDIA-GeForce-RTX-3090", {exact:true}).waitFor();
  assert.equal(await name.inputValue(),"","A new node starts with a fresh name choice");
  const pending = holdAddress(second);
  await address.fill(second);await add.click();await pending.received;
  await page.getByRole("button", {name:"Checking connection…",exact:true}).waitFor();
  await pending.release();
  await page.locator(".fleet-node-copy").getByText("NVIDIA-GeForce-RTX-3090-2", {exact:true}).waitFor();
  await done.click();await page.getByRole("button", {name:"Manage nodes",exact:true}).waitFor();
  assert.equal(await page.locator(".fleet-node-list").textContent(),"","Saved setup must release its draft DOM");
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith("comfyui-fleet:setup:"))),[]);
  assert.deepEqual((await state()).workers,[
    {id:"NVIDIA-GeForce-RTX-3090",url:first,enabled:true},
    {id:"NVIDIA-GeForce-RTX-3090-2",url:second,enabled:true},
  ]);
});

for (const chosenName of ["Render box", ""]) test(`a manually ${chosenName ? "edited" : "cleared"} name survives checks, address edits, and reloads`, { timeout: 30000 }, async t => {
  const first = "http://192.168.1.20:8188", second = "http://192.168.1.21:8188";
  const {page,address,name,add,done,state,holdAddress} = await setup(t, {checkedHardware:{[first]:gpuHardware(),[second]:gpuHardware("NVIDIA GeForce RTX 4090")}});
  const pending = holdAddress(first);
  await address.fill(first);await pending.received;
  await name.fill("My choice");await name.fill(chosenName);
  await pending.release();
  assert.equal(await name.inputValue(),chosenName,"A response must not overwrite the user's choice, including an empty name");
  await page.reload();await address.waitFor();
  assert.equal(await name.inputValue(),chosenName);
  await address.fill(second);await page.getByTitle("Connection verified", {exact:true}).waitFor();
  assert.equal(await name.inputValue(),chosenName);
  await add.click();await page.getByRole("heading", {name:"Build your fleet",exact:true}).waitFor();
  await done.click();await page.getByRole("button", {name:"Manage nodes",exact:true}).waitFor();
  assert.deepEqual((await state()).workers,[{id:chosenName ? "Render-box" : "node-1",url:second,enabled:true}]);
});

test("a detected name can be cleared and cancelling restores automatic names for the next node", { timeout: 30000 }, async t => {
  const url = "http://192.168.1.20:8188";
  const {page,address,name,add,state,done} = await setup(t, {checkedHardware:{[url]:gpuHardware()}});
  await address.fill(url);await page.getByTitle("Connection verified", {exact:true}).waitFor();
  assert.equal(await name.inputValue(),"NVIDIA GeForce RTX 3090");
  await name.fill("");await address.focus();await name.focus();
  assert.equal(await name.inputValue(),"","Reusing a check does not restore a deliberately cleared name");
  await page.getByRole("button", {name:"Clear fields",exact:true}).click();
  await address.fill(url);await page.getByTitle("Connection verified", {exact:true}).waitFor();
  assert.equal(await name.inputValue(),"NVIDIA GeForce RTX 3090");
  await name.fill("My GPU");await add.click();
  await page.getByRole("heading", {name:"Build your fleet",exact:true}).waitFor();
  await done.click();await page.getByRole("button", {name:"Manage nodes",exact:true}).waitFor();
  assert.deepEqual((await state()).workers,[{id:"My-GPU",url,enabled:true}]);
});

test("setup shows checked hardware before Add, keeps it in the draft, and saves only configuration", { timeout: 30000 }, async t => {
  const url = "http://192.168.1.20:8188";
  const info = gpuHardware();
  info.devices.push({name:"cuda:1 Tesla V100-PCIE-32GB : cudaMallocAsync",type:"cuda",vram_total:32 * 1024 ** 3});
  const {page,address,name,add,done,state,checks} = await setup(t, {checkedHardware:{[url]:info}});
  await address.fill(url);await name.click();await name.fill("Studio");
  const detected = page.getByRole("group", {name:"Detected hardware",exact:true});
  await detected.getByText("NVIDIA GeForce RTX 3090", {exact:true}).waitFor();
  assert.equal(await detected.getByText("24 GiB VRAM", {exact:true}).isVisible(),true);
  assert.equal(await detected.getByText("64 GiB RAM", {exact:true}).isVisible(),true);
  assert.equal(await detected.getByText("Tesla V100-PCIE-32GB", {exact:true}).isVisible(),true);
  assert.equal(await detected.getByText("32 GiB VRAM", {exact:true}).isVisible(),true);
  assert.equal(await name.evaluate(el=>el===document.activeElement),true);
  assert.deepEqual((await state()).workers,[]);
  await add.click();
  await page.getByRole("heading", {name:"Build your fleet",exact:true}).waitFor();
  const card = page.locator(".fleet-node-card").filter({hasText:"Studio"});
  await card.getByText("NVIDIA GeForce RTX 3090", {exact:true}).waitFor();
  assert.equal(await card.getByRole("checkbox").count(),0);
  assert.equal(await card.getByText(/Connection checked|Use this node for new jobs/).count(),0);
  assert.equal(await detected.isVisible(),false);
  assert.deepEqual(checks(),[url],"Add reuses the same connectivity and hardware response");
  await page.reload();
  await card.getByText("NVIDIA GeForce RTX 3090", {exact:true}).waitFor();
  assert.equal(await card.getByText("64 GiB RAM", {exact:true}).isVisible(),true);
  assert.equal(await card.getByText("Tesla V100-PCIE-32GB", {exact:true}).isVisible(),true);
  await done.click();await page.getByRole("button", {name:"Manage nodes",exact:true}).waitFor();
  assert.deepEqual((await state()).workers,[{id:"Studio",url,enabled:true}]);
});

test("setup clears edited hardware and ignores late hardware from a previous address", { timeout: 30000 }, async t => {
  const first = "http://192.168.1.20:8188", second = "http://192.168.1.21:8188", broken = "http://192.168.1.22:8188";
  const {page,address,name,holdAddress,failAddress} = await setup(t, {checkedHardware:{[first]:gpuHardware(),[second]:gpuHardware("NVIDIA GeForce RTX 4090")}});
  const old = holdAddress(first);
  await address.fill(first);await name.click();await old.received;
  const detected = page.getByRole("group", {name:"Detected hardware",exact:true});
  assert.equal(await detected.isVisible(),false);
  await address.fill(second);await name.click();
  await detected.getByText("NVIDIA GeForce RTX 4090", {exact:true}).waitFor();
  assert.equal(await name.inputValue(),"NVIDIA GeForce RTX 4090");
  await old.release();
  assert.equal(await name.inputValue(),"NVIDIA GeForce RTX 4090","Late hardware must not replace the current name suggestion");
  assert.equal(await detected.getByText("NVIDIA GeForce RTX 4090", {exact:true}).isVisible(),true);
  assert.equal(await detected.getByText("NVIDIA GeForce RTX 3090", {exact:true}).count(),0);
  failAddress(broken,"Node is offline.");
  await address.fill(broken);
  assert.equal(await name.inputValue(),"","Changing an address clears its automatic name");
  assert.equal(await detected.isVisible(),false);
  assert.equal(await detected.getByText("NVIDIA GeForce RTX 4090", {exact:true}).count(),0);
  await name.click();await page.getByText("Node is offline.", {exact:true}).waitFor();
  assert.equal(await detected.isVisible(),false);
});

for (const [label, info, expected] of [
  ["missing optional fields", {}, "Device not reported"],
  ["older check endpoint", null, "Hardware unavailable"],
  ["CPU-only node", {devices:[{name:"cpu",type:"cpu",vram_total:32 * 1024 ** 3}],ram_total:32 * 1024 ** 3}, "CPU"],
]) test(`setup still accepts a reachable node with ${label}`, { timeout: 30000 }, async t => {
  const url = "http://192.168.1.20:8188";
  const {page,address,name,add,done,state} = await setup(t, {checkedHardware:{[url]:info}});
  await address.fill(url);await name.click();
  const detected = page.getByRole("group", {name:"Detected hardware",exact:true});
  await detected.getByText(expected, {exact:true}).waitFor();
  assert.equal(await name.inputValue(),"","Without a GPU model there is no name to prefill");
  if (label === "CPU-only node") {
    assert.equal(await detected.getByText("32 GiB RAM", {exact:true}).isVisible(),true);
    assert.equal(await detected.getByText(/VRAM/).count(),0);
  }
  await add.click();await page.locator(".fleet-node-card").getByText(expected, {exact:true}).waitFor();
  await done.click();await page.getByRole("button", {name:"Manage nodes",exact:true}).waitFor();
  assert.deepEqual((await state()).workers,[{id:"node-1",url,enabled:true}]);
});

test("Manage nodes refreshes hardware without losing focus and preserves existing disabled nodes", { timeout: 30000 }, async t => {
  const worker = {id:"Studio",url:"http://192.168.1.20:8188",enabled:false};
  const {page,address,add,done,state,updateHardware,checks} = await setup(t, {workers:[worker]});
  await page.getByRole("button", {name:"Manage nodes",exact:true}).click();
  const card = page.locator(".fleet-node-card").filter({hasText:"Studio"});
  const remove = card.getByRole("button", {name:"Remove Studio",exact:true});
  await remove.focus();
  updateHardware({Studio:{...gpuHardware(),url:worker.url,available:true}});
  await card.getByText("NVIDIA GeForce RTX 3090", {exact:true}).waitFor();
  assert.equal(await remove.evaluate(el=>el===document.activeElement),true);
  updateHardware({Studio:{...gpuHardware(),url:worker.url,available:false}});
  await card.getByText("Last detected · unable to refresh", {exact:true}).waitFor();
  assert.equal(await remove.evaluate(el=>el===document.activeElement),true);
  assert.deepEqual(checks(),[]);
  const url = "http://192.168.1.21:8188";
  await address.fill(url);await add.click();
  await page.getByText("Node 1", {exact:true}).waitFor();
  assert.equal(await page.locator(".fleet-setup").getByRole("checkbox").count(),0);
  assert.equal(await page.getByText(/Connection checked|Use this node for new jobs/).count(),0);
  await done.click();await page.getByRole("button", {name:"Manage nodes",exact:true}).waitFor();
  assert.deepEqual((await state()).workers,[worker,{id:"node-1",url,enabled:true}]);
});

test("each node shows its own hardware without losing focus or activity on refresh", { timeout: 30000 }, async t => {
  const workers = [{id:"node-1",url:"http://192.168.1.20:8188",enabled:true},
    {id:"node-2",url:"http://192.168.1.21:8188",enabled:false}];
  const {page,updateHardware} = await setup(t, {workers});
  const list = page.getByRole("list", {name:"Your nodes",exact:true});
  const first = list.locator("li").nth(0), second = list.locator("li").nth(1);
  await first.getByText("Detecting hardware…", {exact:true}).waitFor();
  const toggle = first.getByRole("switch", {name:"Node 1",exact:true});
  await toggle.focus();
  const hardware = {
    "node-1": {url:workers[0].url,available:true,ram_total:64 * 1024 ** 3,
      devices:[{name:"cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync",type:"cuda",vram_total:25296044032}]},
    "node-2": {url:workers[1].url,available:true,ram_total:32 * 1024 ** 3,
      devices:[{name:"cpu",type:"cpu",vram_total:32 * 1024 ** 3}]},
  };
  updateHardware(hardware);
  await first.getByText("NVIDIA GeForce RTX 3090", {exact:true}).waitFor();
  await first.getByText("23.6 GiB VRAM", {exact:true}).waitFor();
  await first.getByText("64 GiB RAM", {exact:true}).waitFor();
  await second.getByText("CPU", {exact:true}).waitFor();
  await second.getByText("32 GiB RAM", {exact:true}).waitFor();
  assert.equal(await second.getByText(/VRAM/).count(),0);
  assert.equal(await second.getByText(/3090/).count(),0);
  assert.equal(await toggle.evaluate(el=>el===document.activeElement),true);
  assert.equal(await first.getByRole("region", {name:"Node 1 activity",exact:true}).isVisible(),false);
  hardware["node-1"].available = false;
  await first.getByText("Last detected · unable to refresh", {exact:true}).waitFor();
  assert.equal(await first.getByText("NVIDIA GeForce RTX 3090", {exact:true}).isVisible(),true);
  hardware["node-1"].url = "http://192.168.1.99:8188";
  await first.getByText("Detecting hardware…", {exact:true}).waitFor();
  assert.equal(await first.getByText("NVIDIA GeForce RTX 3090", {exact:true}).count(),0);
  hardware["node-1"] = {...hardware["node-1"],url:workers[0].url,available:true,
    devices:[{name:"<img src=x onerror=alert(1)>",type:"cuda",vram_total:0}]};
  await first.getByText("<img src=x onerror=alert(1)>", {exact:true}).waitFor();
  assert.equal(await first.locator(".fleet-worker-hardware img").count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true);
});

test("queue cancellation leaves assigned jobs alone and later work can still be queued", { timeout: 30000 }, async t => {
  const workers = [{id:"node-1",url:"http://192.168.1.20:8188",enabled:true},
    {id:"node-2",url:"http://192.168.1.21:8188",enabled:true}];
  const running = fixtureJob(0, {state:"outstanding",worker_id:"node-1",occupied:1,submit_intent:1});
  const preparing = fixtureJob(1, {state:"preparing",worker_id:"node-2",occupied:1});
  const waiting = [fixtureJob(2),fixtureJob(3)];
  const { page, state, updateJobs, failQueue } = await setup(t, {workers, jobs:[running,preparing,...waiting]});
  const queue = page.getByRole("region", {name:"Queued Fleet batches",exact:true});
  assert.equal(await queue.locator("li").count(),1);
  assert.equal(await queue.getByText("2 active · 2 queued",{exact:true}).isVisible(),true);
  failQueue("Storage is unavailable.");
  await queue.getByRole("button", {name:"Cancel queued jobs",exact:true}).click();await confirmCancellation(page);
  await page.getByText("Could not cancel queued jobs. Storage is unavailable.", {exact:true}).waitFor();
  assert.equal((await state()).jobs.filter(job=>job.state==="waiting").length,2);
  failQueue(null);
  await queue.getByRole("button", {name:"Cancel queued jobs",exact:true}).click();await confirmCancellation(page);
  await page.getByText("Cancelled 2 queued jobs.", {exact:true}).waitFor();
  assert.equal(await queue.getByRole("button", {name:"Cancel queued jobs",exact:true}).isEnabled(),false);
  const saved = await state();
  assert.equal(saved.paused,false);
  assert.deepEqual(saved.jobs.slice(0,2),[running,preparing]);
  assert(saved.jobs.slice(2).every(job=>job.state==="cancelled"));
  const later = fixtureJob(0);
  updateJobs([...saved.jobs,later]);
  await queue.locator(`li[data-batch-id="${later.batch_id}"]`).waitFor();
  assert.equal(await queue.getByRole("button", {name:"Cancel queued jobs",exact:true}).isEnabled(),true);
});

test("Cancel active jobs sits beside Your nodes and waits for nodes to stop without cancelling queued work", { timeout: 30000 }, async t => {
  const workers = [{id:"node-1",url:"http://192.168.1.20:8188",enabled:true},
    {id:"node-2",url:"http://192.168.1.21:8188",enabled:false}];
  const running = fixtureJob(0,{state:"outstanding",worker_id:"node-1",occupied:1,submit_intent:1});
  const preparing = fixtureJob(1,{state:"preparing",worker_id:"node-2",occupied:1});
  const waiting = fixtureJob(2);
  const finished = fixtureJob(3,{state:"succeeded",worker_id:"node-1",collection_state:"collected"});
  const released = fixtureJob(4,{state:"unknown",worker_id:"node-2",submit_intent:1,collection_state:"unavailable"});
  const jobs = [running,preparing,waiting,finished,released];
  const original = structuredClone(jobs);
  const {page,state,updateJobs,holdCancelActive,cancellations} = await setup(t,{workers,jobs});
  const all = page.locator(".fleet-nodes-heading").getByRole("button",{name:"Cancel active jobs",exact:true});
  const queue = page.getByRole("button",{name:"Cancel queued jobs",exact:true});
  assert.equal(await all.isEnabled(),true);
  assert.equal(await all.evaluate(el=>getComputedStyle(el).color),"rgb(242, 166, 166)");
  assert.equal(await queue.evaluate(el=>getComputedStyle(el).color),"rgb(242, 166, 166)");
  const pending = holdCancelActive();
  await all.click();await confirmCancellation(page);await pending.received;
  const stopping = page.locator(".fleet-nodes-heading").getByRole("button",{name:"Stopping…",exact:true});
  assert.equal(await stopping.isEnabled(),false);
  assert.equal(await queue.isEnabled(),false);
  assert.equal(await page.getByRole("button",{name:"Cancel",exact:true}).count(),0);
  assert.deepEqual((await state()).jobs,original,"The UI must not claim cancellation has completed before the server applies it");
  const late = fixtureJob(5);
  updateJobs([...jobs,late]);
  await page.waitForResponse(response=>response.url().endsWith("/fleet/state"));
  assert.equal(await stopping.isEnabled(),false,"Polling cannot re-enable an in-flight global action");
  pending.release();
  await page.getByText("Cancellation requested for 2 active jobs.",{exact:true}).waitFor();
  const saved = await state();
  assert.deepEqual(cancellations(),[{path:"/fleet/jobs/cancel-active",body:{}}]);
  assert.deepEqual(saved.workers,workers);
  assert.deepEqual(saved.jobs.find(job=>job.id===finished.id),original[3]);
  assert.deepEqual(saved.jobs.find(job=>job.id===released.id),original[4]);
  assert.equal(saved.jobs.find(job=>job.id===running.id).state,"outstanding");
  assert.equal(saved.jobs.find(job=>job.id===running.id).cancel_requested,1);
  assert.equal(saved.jobs.find(job=>job.id===preparing.id).state,"cancelled");
  for (const id of [waiting.id,late.id]) assert.equal(saved.jobs.find(job=>job.id===id).state,"waiting");
  assert.equal(await stopping.isEnabled(),false,"Wait for the active node's acknowledgement");
  const stopped = saved.jobs.map(job=>job.id===running.id ? {...job,state:"cancelled",occupied:0,collection_state:"not_applicable"} : job);
  updateJobs(stopped);await all.waitFor();
  assert.equal(await all.isEnabled(),false);
  const later = fixtureJob(6,{state:"outstanding",worker_id:"node-1",occupied:1,submit_intent:1});
  updateJobs([...stopped,later]);
  await page.locator(`.fleet-worker-details [data-job-id="${later.id}"]`).waitFor();
  assert.equal(await all.isEnabled(),true);
  assert.equal(await queue.isEnabled(),true);
  assert.equal((await state()).paused,false);
});

test("a failed Cancel active jobs request leaves work intact and can be retried", {timeout:30000}, async t=>{
  const workers = [{id:"node-1",url:"http://192.168.1.20:8188",enabled:true}];
  const jobs = [fixtureJob(0,{state:"outstanding",worker_id:"node-1",occupied:1,submit_intent:1}),fixtureJob(1)];
  const original = structuredClone(jobs);
  const {page,state,failCancelActive} = await setup(t,{workers,jobs});
  const all = page.getByRole("button",{name:"Cancel active jobs",exact:true});
  failCancelActive("Storage is unavailable.");
  await all.click();await confirmCancellation(page);await page.getByText("Could not cancel active jobs. Storage is unavailable.",{exact:true}).waitFor();
  assert.deepEqual((await state()).jobs,original);
  assert.equal(await all.isEnabled(),true);
  assert.equal(await page.getByRole("button",{name:"Cancel queued jobs",exact:true}).isEnabled(),true);
  assert.equal(await page.getByRole("button",{name:"Cancel",exact:true}).count(),0);
  failCancelActive(null);
  await all.click();await confirmCancellation(page);await page.getByText("Cancellation requested for 1 active job.",{exact:true}).waitFor();
  assert.equal(await page.getByText("Could not cancel active jobs. Storage is unavailable.",{exact:true}).count(),0);
  assert.equal((await state()).jobs[0].cancel_requested,1);
  assert.deepEqual((await state()).jobs[1],original[1]);
});

test("result errors are reported once without recovery controls or lingering activity", {timeout:30000}, async t=>{
  const workers = [{id:"node-1",url:"http://192.168.1.20:8188",enabled:true}];
  const unknown = fixtureJob(0,{state:"unknown",worker_id:"node-1",occupied:1,submit_intent:1,error:"Connection lost; outcome unknown."});
  const collecting = fixtureJob(1,{state:"succeeded",worker_id:"node-1",collection_state:"error",error:"Could not save the output."});
  const {page,jobActions,updateJobs} = await setup(t,{workers,jobs:[unknown,collecting]});
  const region = page.getByRole("region",{name:"Node 1 activity",exact:true});
  await region.getByText("Checking job",{exact:true}).waitFor();
  assert.equal(await region.getByText("Fleet is checking this job. If the node no longer has it, it will be dropped and queued work will continue.",{exact:true}).isVisible(),true);
  assert.equal(await region.getByText("Connection lost; outcome unknown.",{exact:true}).count(),0);
  await page.getByText(/Could not save the output\. The job is closed\./).waitFor();
  assert.equal(await region.locator(`[data-job-id="${collecting.id}"]`).count(),0);
  assert.equal(await region.locator("details").count(),0);
  assert.equal(await region.getByText(/Job ID:|Batch ID:|Assigned by Fleet/).count(),0);
  assert.equal(await region.getByRole("button",{name:"View progress",exact:true}).count(),0);
  assert.equal(await region.locator(`[data-job-id="${unknown.id}"]`).getByRole("button",{name:"Cancel job",exact:true}).isEnabled(),true);
  assert.equal(await region.locator(`[data-job-id="${collecting.id}"]`).getByRole("button",{name:"Cancel job",exact:true}).count(),0,"A completed job waiting for recovery cannot be cancelled");
  assert.equal(await region.getByRole("button",{name:"Verify inactivity and release worker",exact:true}).count(),0);
  assert.equal(await page.getByRole("button",{name:"Retry saving results",exact:true}).count(),0);
  await page.getByRole("button",{name:"Dismiss notification",exact:true}).click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".fleet-notification").isVisible(),false);
  assert.deepEqual(jobActions(),[]);
  updateJobs([{...unknown,state:"cancelled",occupied:0,collection_state:"not_applicable"},
    {...collecting,collection_state:"partial",error:null},
    fixtureJob(2,{state:"succeeded",worker_id:"node-1",collection_state:"unavailable"})]);
  await region.locator(`[data-job-id="${unknown.id}"]`).waitFor({state:"hidden"});
  await region.locator(`[data-job-id="${collecting.id}"]`).waitFor({state:"hidden"});
  assert.equal(await region.getByRole("button",{name:"Retry saving results",exact:true}).count(),0);
  assert.equal(await region.getByText("Results need attention",{exact:true}).count(),0);
  assert.equal(await region.getByText("Needs review",{exact:true}).count(),0);
});

test("nodes keep compact job details with a small cancel control alongside the global controls", { timeout: 30000 }, async t => {
  const workers = [{id:"node-1",url:"http://192.168.1.20:8188",enabled:true},
    {id:"node-2",url:"http://192.168.1.21:8188",enabled:true}];
  const running = fixtureJob(0, {state:"outstanding",worker_id:"node-1",occupied:1,submit_intent:1});
  const waiting = fixtureJob(1);
  const { page, state, updateJobs, cancellations } = await setup(t, {workers,jobs:[running,waiting]});
  const first = page.getByRole("region", {name:"Node 1 activity",exact:true});
  await first.getByText("Workflow batch", {exact:true}).waitFor();
  assert.equal(await first.getByText("In progress", {exact:true}).isVisible(),true);
  assert.equal(await first.getByText(/^Job \d+/).count(),0);
  assert.equal(await first.getByRole("progressbar").count(),0);
  assert.equal(await page.getByRole("button", {name:"View progress",exact:true}).count(),0);
  assert.equal(await first.getByText(/Details|Assigned by Fleet|Job ID:|Batch ID:/).count(),0);
  assert.equal(await first.getByRole("button",{name:"Cancel job",exact:true}).isEnabled(),true);
  assert.deepEqual(await page.getByRole("button", {name:/^Cancel/}).allTextContents(),["Cancel queued jobs","Cancel batch","Cancel active jobs","Cancel job"]);
  const second = page.getByRole("region", {name:"Node 2 activity",exact:true});
  assert.equal(await second.isVisible(),false);
  const toggle = page.getByRole("switch", {name:"Node 1",exact:true});
  await toggle.focus();
  await page.waitForResponse(response=>response.url().endsWith("/fleet/state"));
  assert(await toggle.evaluate(button=>document.activeElement===button),"Polling must preserve node control focus");
  await toggle.click();
  await page.getByText("Disabled", {exact:true}).waitFor();
  assert.equal(await first.isVisible(),true);
  assert.deepEqual((await state()).jobs[0],running,"Disabling a node does not cancel its assigned job");
  await page.getByRole("button",{name:"Cancel queued jobs",exact:true}).click();await confirmCancellation(page);
  await page.getByText("Cancelled 1 queued job.",{exact:true}).waitFor();
  assert.deepEqual((await state()).jobs[0],running,"Cancelling the queue leaves assigned work intact");
  await page.getByRole("button",{name:"Cancel active jobs",exact:true}).click();await confirmCancellation(page);
  await page.getByText("Cancellation requested for 1 active job.",{exact:true}).waitFor();
  await first.getByText("Cancelling", {exact:true}).waitFor();
  const saved = await state();
  assert.equal(saved.jobs[0].cancel_requested,1,"Active cancellation includes work on disabled nodes");
  assert.equal(saved.jobs[1].state,"cancelled");
  assert.equal(await first.getByRole("button",{name:"Cancelling…",exact:true}).isEnabled(),false);
  assert.deepEqual(cancellations(),[
    {path:"/fleet/queue/cancel",body:{}},{path:"/fleet/jobs/cancel-active",body:{}}
  ]);
  updateJobs(saved.jobs.map(job=>({...job,state:"cancelled",occupied:0,collection_state:"not_applicable"})));
  await first.waitFor({state:"hidden"});
});

test("Queue shows two workflow batches and the complete job counts instead of individual rows", {timeout:30000}, async t=>{
  const workers=[{id:"node-1",url:"http://192.168.1.20:8188",enabled:true}];
  const jobs=Array.from({length:16},(_,i)=>fixtureJob(i,{batch_id:"portraits",state:i<6?"succeeded":i<10?"outstanding":"waiting",worker_id:i<10?"node-1":null,occupied:i>=6&&i<10?1:0}));
  jobs.push(...Array.from({length:16},(_,i)=>fixtureJob(i,{batch_id:"landscapes"})));
  const {page,updateJobs}=await setup(t,{workers,jobs,batchNames:{portraits:"Portraits",landscapes:"Landscapes"}});
  const queue=page.getByRole("region",{name:"Queued Fleet batches",exact:true});
  assert.equal(await queue.locator("li").count(),2);
  assert.equal(await queue.getByText("2 batches",{exact:true}).isVisible(),true);
  assert.equal(await queue.getByText("6 of 16 jobs completed",{exact:true}).isVisible(),true);
  assert.equal(await queue.getByText("4 active · 6 queued",{exact:true}).isVisible(),true);
  assert.equal(await queue.getByText("16 queued",{exact:true}).isVisible(),true);
  assert.equal(await queue.getByRole("button",{name:/Move.*front/}).count(),0);
  const handle=queue.getByRole("button",{name:"Reorder Portraits",exact:true});
  assert.equal(await handle.evaluate(el=>getComputedStyle(el).cursor),"grab");
  await handle.focus();
  updateJobs(jobs.map((job,i)=>i===6?{...job,state:"succeeded",occupied:0}:job));
  await queue.getByText("7 of 16 jobs completed",{exact:true}).waitFor();
  assert.equal(await handle.evaluate(el=>el===document.activeElement),true);
});

for(const batchCount of [1,12]) test(`scrolling over ${batchCount} queued batches moves the panel to the nodes`, {timeout:30000}, async t=>{
  const workers=Array.from({length:3},(_,i)=>({id:`node-${i+1}`,url:`http://192.168.1.${20+i}:8188`,enabled:true}));
  const jobs=Array.from({length:batchCount},(_,i)=>fixtureJob(0,{batch_id:`batch-${i}`}));
  const {page}=await setup(t,{workers,jobs});
  await page.setViewportSize({width:340,height:520});
  const panel=page.locator(".fleet-panel");
  const first=page.locator('.fleet-queue-list li').first();
  const box=await first.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.wheel(0,10000);
  await page.waitForFunction(()=>document.querySelector('.fleet-panel').scrollTop>0,null,{timeout:2000});
  const node=page.getByRole("switch",{name:"Node 3",exact:true});
  assert.equal(await node.evaluate(el=>{
    const box=el.getBoundingClientRect();
    return box.top>=0&&box.bottom<=innerHeight;
  }),true,"Wheel scrolling over the queue must reach the nodes below it");
  const last=page.locator('.fleet-queue-list li').last();
  await last.scrollIntoViewIfNeeded();
  const lastBox=await last.boundingBox();
  await page.mouse.move(lastBox.x+lastBox.width/2,lastBox.y+lastBox.height/2);
  await page.mouse.wheel(0,-10000);
  await page.waitForFunction(()=>document.querySelector('.fleet-panel').scrollTop===0,null,{timeout:2000});
  assert.equal(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
});

test("dragging through a long queue scrolls to the edge, saves batch order, and survives reload", {timeout:30000}, async t=>{
  const workers=[{id:"node-1",url:"http://192.168.1.20:8188",enabled:true}];
  const jobs=Array.from({length:12},(_,i)=>fixtureJob(0,{batch_id:`batch-${i}`}));
  const {page,reorders}=await setup(t,{workers,jobs});
  const queue=page.getByRole("region",{name:"Queued Fleet batches",exact:true});
  assert.equal(await queue.locator("li").count(),12,"All batches remain in the panel; no pagination barrier");
  assert.equal(await queue.getByRole("button",{name:"Next",exact:true}).count(),0);
  const last=queue.locator('[data-batch-id="batch-11"]').getByRole("button",{name:/^Reorder /});
  await last.scrollIntoViewIfNeeded();
  const box=await last.boundingBox(),scrollBox=await page.locator(".fleet-panel").boundingBox();
  assert.equal(await page.locator(".fleet-panel").evaluate(el=>el.scrollTop>0),true);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2,scrollBox.y+3,{steps:10});
  await page.waitForFunction(()=>document.querySelector('.fleet-panel').scrollTop===0);
  assert.equal(await queue.locator('[data-drop="before"]').first().getAttribute("data-batch-id"),"batch-0");
  await page.waitForResponse(response=>response.url().endsWith('/fleet/state'));
  assert.equal(await queue.locator('[data-dragging="true"]').count(),1,"Polling keeps the dragged card attached");
  await page.mouse.up();
  await page.getByText("Batch order saved. Active jobs keep running.",{exact:true}).waitFor();
  assert.deepEqual(reorders(),[{batch_id:"batch-11",before_batch_id:"batch-0"}]);
  assert.equal(await queue.locator("li").first().getAttribute("data-batch-id"),"batch-11");
  await page.reload();await queue.waitFor();
  assert.equal(await queue.locator("li").first().getAttribute("data-batch-id"),"batch-11");
});

test("keyboard reordering can be cancelled and preserves new arrivals during a pending save", {timeout:30000}, async t=>{
  const workers=[{id:"node-1",url:"http://192.168.1.20:8188",enabled:true}];
  const jobs=[fixtureJob(0,{batch_id:"a"}),fixtureJob(0,{batch_id:"b"}),fixtureJob(0,{batch_id:"c"})];
  const {page,reorders,holdOrder,updateJobs}=await setup(t,{workers,jobs});
  const handle=page.locator('[data-batch-id="a"]').getByRole("button",{name:/^Reorder /});
  await handle.focus();await handle.press("Space");await handle.press("End");await handle.press("Escape");
  assert.deepEqual(reorders(),[]);
  assert.equal(await page.locator('.fleet-queue-list li').first().getAttribute('data-batch-id'),"a");
  const gate=holdOrder();
  await handle.press("Space");await handle.press("ArrowDown");await handle.press("Space");await gate.received;
  updateJobs([...jobs,fixtureJob(0,{batch_id:"late"})]);
  await page.waitForResponse(response=>response.url().endsWith('/fleet/state'));
  assert.equal(await page.getByRole('button',{name:'Cancel active jobs',exact:true}).isEnabled(),false);
  assert.equal(await page.getByRole('button',{name:'Cancel queued jobs',exact:true}).isEnabled(),false);
  assert.equal(await handle.isEnabled(),false);
  gate.release();await page.getByText("Batch order saved. Active jobs keep running.",{exact:true}).waitFor();
  assert.deepEqual(reorders(),[{batch_id:"a",before_batch_id:"c"}]);
  assert.deepEqual(await page.locator('.fleet-queue-list li').evaluateAll(rows=>rows.map(row=>row.dataset.batchId)),["b","a","c","late"]);
});

test("failed or stale batch drops restore the server order and leave assigned jobs alone", {timeout:30000}, async t=>{
  const workers=[{id:"node-1",url:"http://192.168.1.20:8188",enabled:true}];
  const jobs=[fixtureJob(0,{batch_id:"a"}),fixtureJob(0,{batch_id:"b"})];
  const {page,failOrder,updateJobs,state}=await setup(t,{workers,jobs});
  const handle=page.locator('[data-batch-id="b"]').getByRole("button",{name:/^Reorder /});
  failOrder("Storage is unavailable.");
  await handle.focus();await handle.press("Space");await handle.press("Home");await handle.press("Space");
  await page.getByText("Could not reorder batches. Storage is unavailable.",{exact:true}).waitFor();
  assert.deepEqual(await page.locator('.fleet-queue-list li').evaluateAll(rows=>rows.map(row=>row.dataset.batchId)),["a","b"]);
  assert.deepEqual((await state()).jobs,jobs);
  failOrder(null);
  await handle.press("Space");await handle.press("Home");
  const assigned={...jobs[1],state:"preparing",worker_id:"node-1",occupied:1};
  updateJobs([jobs[0],assigned]);
  await page.waitForResponse(response=>response.url().endsWith('/fleet/state'));
  await handle.press("Space");
  await page.getByText(/Could not reorder batches. The queue changed/).waitFor();
  assert.equal(await page.locator('.fleet-queue-list li').count(),1);
  assert.deepEqual((await state()).jobs[1],assigned);
});

test("dashboard switches persist each node's state and remain usable across refreshes", { timeout: 30000 }, async t => {
  const workers = [{id:"node-1",url:"http://192.168.1.20:8188",enabled:true},
    {id:"studio-pc",url:"http://192.168.1.21:8188",enabled:false}];
  const { page, state } = await setup(t, {workers});
  const first = page.getByRole("switch", {name:"Node 1",exact:true});
  const second = page.getByRole("switch", {name:"studio-pc",exact:true});
  assert.equal(await page.getByRole("button", {name:"Follow local activity"}).count(), 0);
  assert.equal(await page.getByRole("button", {name:"Cancel preparation"}).count(), 0);
  assert.equal(await first.getAttribute("aria-checked"), "true");
  assert.equal(await second.getAttribute("aria-checked"), "false");
  await first.click();
  await page.locator('[role=switch][aria-label="Node 1"][aria-checked=false]').waitFor();
  assert.deepEqual((await state()).workers, [{...workers[0],enabled:false},workers[1]]);
  await page.reload();await first.waitFor();
  assert.equal(await first.getAttribute("aria-checked"), "false");
  await second.focus();await second.press("Space");
  await page.locator('[role=switch][aria-label="studio-pc"][aria-checked=true]').waitFor();
  assert.deepEqual((await state()).workers, [{...workers[0],enabled:false},{...workers[1],enabled:true}]);
  await second.focus();
  await page.waitForResponse(response => response.url().endsWith("/fleet/state"));
  assert(await second.evaluate(button => document.activeElement === button), "Polling must preserve switch focus");
  assert.equal(await page.getByRole("button", {name:/Pause dispatch|Resume dispatch/}).count(), 0);
  assert(await page.getByText("Backup & recovery", {exact:true}).isVisible());
});

test("a failed node toggle preserves saved state and prevents overlapping configuration writes", { timeout: 30000 }, async t => {
  const workers = [{id:"node-1",url:"http://192.168.1.20:8188",enabled:true},
    {id:"node-2",url:"http://192.168.1.21:8188",enabled:true}];
  const { page, state, holdConfiguration, failConfiguration } = await setup(t, {workers});
  const first = page.getByRole("switch", {name:"Node 1",exact:true});
  const second = page.getByRole("switch", {name:"Node 2",exact:true});
  failConfiguration("Storage is unavailable.");
  const pending = holdConfiguration();
  await first.click();await pending.received;
  await page.waitForResponse(response => response.url().endsWith("/fleet/state"));
  assert.equal(await first.isEnabled(), false);
  assert.equal(await second.isEnabled(), false);
  assert.equal(await page.getByRole("button", {name:"Manage nodes",exact:true}).isEnabled(), false);
  assert.equal(await first.getAttribute("aria-checked"), "true", "The switch must not claim an unsaved change");
  await page.getByText("Saving…", {exact:true}).waitFor();
  pending.release();
  await page.getByText("Could not save this change. Storage is unavailable.", {exact:true}).waitFor();
  assert.equal(await first.isEnabled(), true);
  assert.equal(await first.getAttribute("aria-checked"), "true");
  assert.deepEqual((await state()).workers, workers);
  failConfiguration(null);
  await first.click();await page.locator('[role=switch][aria-label="Node 1"][aria-checked=false]').waitFor();
  assert.deepEqual((await state()).workers, [{...workers[0],enabled:false},workers[1]]);
  assert.equal(await page.getByText("Could not save this change. Storage is unavailable.", {exact:true}).isVisible(), false);
});

test("a pending check spins inside the input, respects reduced motion, and becomes a tick on success", { timeout: 30000 }, async t => {
  const url = "http://192.168.1.20:8188";
  const {page,address,name,holdAddress} = await setup(t);
  const pending = holdAddress(url);
  await address.fill(url);await pending.received;
  const spinner = page.getByTitle("Checking connection…", {exact:true});
  await spinner.waitFor();
  assert.equal(await address.getAttribute("aria-busy"),"true");
  assert.equal(await address.evaluate(el=>el===document.activeElement),true);
  assert.equal(await name.isEnabled(),true);
  const appearance = await spinner.evaluate(el=>{
    const style = getComputedStyle(el,"::before");
    return {animation:style.animationName,duration:style.animationDuration,radius:style.borderRadius};
  });
  assert.equal(appearance.animation,"fleet-address-spin");
  assert.equal(appearance.duration,"0.75s");
  assert.equal(appearance.radius,"50%");
  const inputBox = await address.boundingBox(), spinnerBox = await spinner.boundingBox();
  assert(spinnerBox.x > inputBox.x + inputBox.width - 40 && spinnerBox.x + spinnerBox.width < inputBox.x + inputBox.width);
  assert(Math.abs(spinnerBox.y + spinnerBox.height / 2 - inputBox.y - inputBox.height / 2) < 1);
  await page.emulateMedia({reducedMotion:"reduce"});
  assert.equal(await spinner.evaluate(el=>getComputedStyle(el,"::before").animationName),"none");
  await pending.release();
  const tick = page.getByTitle("Connection verified", {exact:true});
  await tick.waitFor();
  assert.equal(await tick.textContent(),"✓");
  assert.equal(await address.getAttribute("aria-busy"),"false");
  assert.equal(await spinner.count(),0);
  const tickBox = await tick.boundingBox();
  assert.equal(tickBox.x,spinnerBox.x);
  assert.equal(tickBox.y,spinnerBox.y,"The status indicator stays in the same position");
});

test("typing and pasting verify after 200 ms without blur, with only a tick and hardware on success", { timeout: 30000 }, async t => {
  const first = "http://192.168.1.20:8188", second = "http://192.168.1.21:8188";
  const {page,address,checks} = await setup(t, {clock:true,checkedHardware:{[first]:gpuHardware(),[second]:gpuHardware("NVIDIA GeForce RTX 4090")}});
  await address.pressSequentially("192.168.1.20:818");
  await page.clock.runFor(199);
  assert.deepEqual(checks(),[]);
  await address.press("8");
  await page.clock.runFor(199);
  assert.deepEqual(checks(),[],"Each keystroke restarts the debounce");
  const firstResponse = page.waitForResponse(response => response.url().endsWith("/fleet/workers/check"));
  await page.clock.runFor(1);await firstResponse;
  const tick = page.getByTitle("Connection verified", {exact:true});
  await tick.waitFor();
  assert.equal(await tick.textContent(),"✓");
  assert.equal(await tick.evaluate(el=>getComputedStyle(el).pointerEvents),"auto","The tick accepts hover for its tooltip");
  const detected = page.getByRole("group", {name:"Detected hardware",exact:true});
  assert.equal(await detected.getByText("NVIDIA GeForce RTX 3090", {exact:true}).isVisible(),true);
  assert.equal(await address.evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.getByText("Connection verified", {exact:true}).count(),0);
  assert.deepEqual(checks(),[first]);

  await page.context().grantPermissions(["clipboard-read","clipboard-write"]);
  await page.evaluate(text=>navigator.clipboard.writeText(text),second);
  await address.press("ControlOrMeta+A");await address.press("ControlOrMeta+V");
  assert.equal(await address.inputValue(),second);
  assert.equal(await tick.count(),0,"Editing clears the old tick and tooltip immediately");
  assert.equal(await detected.isVisible(),false);
  await page.clock.runFor(199);
  assert.deepEqual(checks(),[first]);
  const secondResponse = page.waitForResponse(response => response.url().endsWith("/fleet/workers/check"));
  await page.clock.runFor(1);await secondResponse;
  await tick.waitFor();
  assert.equal(await detected.getByText("NVIDIA GeForce RTX 4090", {exact:true}).isVisible(),true);
  assert.equal(await address.evaluate(el=>el===document.activeElement),true);
  await address.press("Tab");await page.clock.runFor(200);
  assert.deepEqual(checks(),[first,second],"Blur reuses a successful automatic check");
});

test("an incomplete address stays neutral while typing and reports its error on blur", { timeout: 30000 }, async t => {
  const {page,address,name,checks} = await setup(t, {clock:true});
  await address.fill("http://");await page.clock.runFor(200);
  assert.equal(await address.getAttribute("aria-invalid"),"false");
  assert.equal(await page.locator(".fleet-inline-error").isVisible(),false);
  assert.deepEqual(checks(),[],"Malformed addresses never reach the server");
  await name.click();await page.locator(".fleet-inline-error").waitFor();
  assert.equal(await address.getAttribute("aria-invalid"),"true");
  assert.equal(await page.locator(".fleet-address-icon").textContent(),"×");
  assert.equal(await page.locator(".fleet-address-icon").isVisible(),true);
  await address.fill("http://");await page.clock.runFor(200);
  assert.equal(await address.getAttribute("aria-invalid"),"false");
  assert.equal(await page.locator(".fleet-inline-error").isVisible(),false);
  assert.equal(await page.locator(".fleet-address-icon").isVisible(),false);
});

test("a failed automatic check stays quiet until blur and Add can retry a recovered node", { timeout: 30000 }, async t => {
  const url = "http://192.168.1.20:8188";
  const {page,address,name,add,checks,failAddress,holdAddress} = await setup(t);
  failAddress(url,"Node is offline.");
  const pending = holdAddress(url);
  await address.fill(url);await pending.received;
  await page.getByTitle("Checking connection…", {exact:true}).waitFor();
  await pending.release();
  assert.equal(await address.evaluate(el=>el===document.activeElement),true);
  assert.equal(await address.getAttribute("aria-invalid"),"false");
  assert.equal(await page.locator(".fleet-inline-error").isVisible(),false);
  assert.equal(await page.getByTitle("Connection verified", {exact:true}).count(),0);
  assert.equal(await address.getAttribute("aria-busy"),"false");
  assert.equal(await page.locator(".fleet-address-icon").isVisible(),false,"A focused failure stops spinning but defers the cross until blur");
  await name.click();await page.getByText("Node is offline.", {exact:true}).waitFor();
  assert.equal(await address.getAttribute("aria-invalid"),"true");
  const cross = page.getByTitle("Node is offline.", {exact:true});
  assert.equal(await cross.isVisible(),true);
  assert.equal(await cross.textContent(),"×");
  assert.equal(await cross.evaluate(el=>getComputedStyle(el).color),"rgb(242, 166, 166)");
  assert.deepEqual(checks(),[url],"Blur displays the completed failure without a second request");
  failAddress(url,null);
  await add.click();await page.getByText("Node 1", {exact:true}).waitFor();
  assert.deepEqual(checks(),[url,url],"An explicit Add retries a previously failed connection");
  assert.equal(await cross.count(),0);
  assert.equal(await address.getAttribute("aria-busy"),"false");
});

test("a failure arriving after refocusing the address waits for the next blur", { timeout: 30000 }, async t => {
  const url = "http://192.168.1.20:8188";
  const {page,address,name,failAddress,holdAddress} = await setup(t);
  failAddress(url,"Node is offline.");
  const pending = holdAddress(url);
  await address.fill(url);await name.click();await pending.received;
  await address.focus();await pending.release();
  assert.equal(await address.getAttribute("aria-invalid"),"false");
  assert.equal(await page.locator(".fleet-inline-error").isVisible(),false);
  await name.click();await page.getByText("Node is offline.", {exact:true}).waitFor();
  assert.equal(await address.getAttribute("aria-invalid"),"true");
});

test("submitting with Enter shows a connection error and never adds an unverified node", { timeout: 30000 }, async t => {
  const url = "http://192.168.1.20:8188";
  const {page,address,checks,failAddress,holdAddress,state} = await setup(t);
  failAddress(url,"Node is offline.");
  const pending = holdAddress(url);
  await address.fill(url);await pending.received;
  await address.press("Enter");
  await page.getByRole("button", {name:"Checking connection…",exact:true}).waitFor();
  await pending.release();await page.getByText("Node is offline.", {exact:true}).waitFor();
  assert.equal(await address.getAttribute("aria-invalid"),"true");
  assert.equal(await page.locator(".fleet-node-card").count(),0);
  assert.deepEqual(checks(),[url],"Submit shares the automatic check already in flight");
  assert.deepEqual((await state()).workers,[]);
});

for (const action of ["Clear fields", "Discard changes"]) test(`${action} cancels a scheduled address check`, { timeout: 30000 }, async t => {
  const workers = action === "Discard changes" ? [{id:"Studio",url:"http://192.168.1.20:8188",enabled:true}] : [];
  const {page,address,checks} = await setup(t, {workers,clock:true});
  if (workers.length) await page.getByRole("button", {name:"Manage nodes",exact:true}).click();
  await address.fill("192.168.1.21:8188");
  await page.getByRole("button", {name:action,exact:true}).click();
  if (action === "Discard changes") await page.getByRole("dialog").getByRole("button", {name:action,exact:true}).click();
  await page.clock.runFor(1000);
  assert.deepEqual(checks(),[]);
  assert.equal(await page.getByRole("group", {name:"Detected hardware",exact:true}).isVisible(),false);
  assert.equal(await page.getByTitle("Connection verified", {exact:true}).count(),0);
});

test("a duplicate address is marked red on blur or Add, but not while editing", { timeout: 30000 }, async t => {
  const { page, address, name, add } = await setup(t);
  await address.fill("192.168.1.20:8188");await add.click();
  await page.getByText("Node 1", { exact: true }).waitFor();
  await address.fill("http://192.168.1.20:8188/");await add.click();
  const error = page.getByText("That address is already in your list.", { exact: true });
  await error.waitFor();
  assert.equal(await address.getAttribute("aria-invalid"), "true");
  const border = await address.evaluate(input => getComputedStyle(input).borderColor);
  assert.equal(border, "rgb(242, 166, 166)");
  const inputBox = await address.boundingBox(), errorBox = await error.boundingBox();
  assert(errorBox.y >= inputBox.y + inputBox.height && errorBox.y < inputBox.y + inputBox.height + 30,
    "Address error should appear immediately below its field");
  await address.fill("192.168.1.20:8188");
  assert.equal(await address.getAttribute("aria-invalid"), "false", "Editing clears errors until the next blur");
  await name.click();await error.waitFor();
  await address.fill("192.168.1.21:8188");await name.click();
  await page.getByTitle("Connection verified", { exact: true }).waitFor();
  assert.equal(await address.getAttribute("aria-invalid"), "false");
  assert.equal(await error.isVisible(), false);
});

test("leaving the address verifies it while the optional name remains editable", { timeout: 30000 }, async t => {
  const { page, address, name, add } = await setup(t);
  await address.fill("192.168.1.20:8188");
  await name.click();await name.fill("Studio PC");
  await page.getByTitle("Connection verified", { exact: true }).waitFor();
  assert(await name.evaluate(input => document.activeElement === input), "Verification must not steal focus from the name");
  const tick = page.getByText("✓", { exact: true });await tick.waitFor();
  const inputBox = await address.boundingBox(), tickBox = await tick.boundingBox();
  assert(tickBox.x > inputBox.x + inputBox.width - 40 && tickBox.x < inputBox.x + inputBox.width,
    "The verification tick belongs at the end of the input");
  await add.click();await page.getByText("Studio-PC", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Done", exact: true }).isVisible(), true);
});

test("an accidental second node can be cancelled and Done saves the first node", { timeout: 30000 }, async t => {
  const { page, address, name, add, done, state } = await setup(t);
  await address.fill("192.168.1.20:8188");await add.click();
  await page.getByText("Node 1", { exact: true }).waitFor();
  await address.fill("192.168.1.21:8188");await name.fill("Accidental node");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Add another node", exact: true }).click();
  assert.equal(await address.inputValue(), "");assert.equal(await name.inputValue(), "");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await done.click();
  await page.getByRole("button", { name: "Manage nodes", exact: true }).waitFor();
  assert.deepEqual((await state()).workers, [{id:"node-1",url:"http://192.168.1.20:8188",enabled:true}]);
});

test("refresh preserves a duplicate error until the unfinished node is cancelled", { timeout: 30000 }, async t => {
  const { page, address, name, add, done, state } = await setup(t);
  await address.fill("192.168.1.20:8188");await add.click();
  await page.getByText("Node 1", { exact: true }).waitFor();
  await address.fill("192.168.1.20:8188");await name.click();
  await page.getByText("That address is already in your list.", { exact: true }).waitFor();
  await page.reload();await page.getByText("Node 1", { exact: true }).waitFor();
  assert.equal(await address.getAttribute("aria-invalid"), "true");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();await page.getByRole("button", { name: "Add another node", exact: true }).waitFor();
  assert.equal(await address.isVisible(), false);
  await done.click();await page.getByRole("button", { name: "Manage nodes", exact: true }).waitFor();
  assert.equal((await state()).workers.length, 1);
});

test("an old connection failure cannot overwrite verification of an edited address", { timeout: 30000 }, async t => {
  const { page, address, name, holdAddress, failAddress } = await setup(t);
  const oldUrl = "http://192.168.1.20:8188";
  const old = holdAddress(oldUrl);failAddress(oldUrl, "The old address could not be reached.");
  await address.fill(oldUrl);await name.click();await old.received;
  assert.equal(await name.isEnabled(), true);
  await address.fill("192.168.1.21:8188");await name.click();
  await page.getByTitle("Connection verified", { exact: true }).waitFor();
  await old.release();
  assert(await page.getByTitle("Connection verified", { exact: true }).isVisible());
  assert.equal(await page.getByText("The old address could not be reached.", { exact: true }).isVisible(), false);
  assert.equal(await address.getAttribute("aria-invalid"), "false");
});

test("cancelling a node during Add lets Done save without a late response adding it", { timeout: 30000 }, async t => {
  const { page, address, name, add, done, state, holdAddress } = await setup(t, {checkedHardware:{
    "http://192.168.1.20:8188":gpuHardware(), "http://192.168.1.21:8188":gpuHardware("NVIDIA GeForce RTX 4090"),
  }});
  await address.fill("192.168.1.20:8188");await add.click();
  await page.getByText("NVIDIA-GeForce-RTX-3090", { exact: true }).waitFor();
  const pending = holdAddress("http://192.168.1.21:8188");
  await address.fill("192.168.1.21:8188");await name.click();await pending.received;
  await add.click();await page.getByRole("button", { name: "Checking connection…", exact: true }).waitFor();
  assert.equal(await address.getAttribute("aria-busy"),"true");
  assert.equal(await page.getByTitle("Checking connection…", {exact:true}).isVisible(),true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.getByRole("textbox", {name:"ComfyUI address",exact:true,includeHidden:true}).getAttribute("aria-busy"),"false");
  assert.equal(await page.getByTitle("Checking connection…", {exact:true}).count(),0);
  await done.click();await page.getByRole("button", { name: "Manage nodes", exact: true }).waitFor();
  await pending.release();
  assert.equal(await page.getByText("NVIDIA GeForce RTX 4090", {exact:true}).count(),0);
  assert.equal(await page.getByRole("group", {name:"Detected hardware",exact:true}).isVisible(),false);
  assert(await page.getByRole("button", { name: "Manage nodes", exact: true }).isVisible());
  assert.deepEqual((await state()).workers, [{id:"NVIDIA-GeForce-RTX-3090",url:"http://192.168.1.20:8188",enabled:true}]);
});
