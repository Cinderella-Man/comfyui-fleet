import test from "node:test";
import assert from "node:assert/strict";
import { SelectedJob } from "../web/progress.js";
import { prepareSnapshots } from "../web/preparation.js";
import * as preparation from "../web/preparation.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { queuedJobs, queuedBatches, workerJobs, jobStatus, nodeAddress, nodeName, hardwareDetails, suggestedNodeName } from "../web/panel.js";

test("hardware labels clean device wrappers, keep models distinct, and use honest memory units", () => {
  const info = { available: true, ram_total: 64 * 1024 ** 3, devices: [
    {name:"cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync",type:"cuda",vram_total:25296044032},
    {name:"cuda:1 AMD Radeon RX 7900 XTX : native",type:"cuda",vram_total:24 * 1024 ** 3},
    {name:"xpu:0 Intel Arc A770",type:"xpu",vram_total:16 * 1024 ** 3},
    {name:"mps",type:"mps",vram_total:18 * 1024 ** 3},
    {name:"cpu",type:"cpu",vram_total:64 * 1024 ** 3},
  ]};
  assert.deepEqual(hardwareDetails(info), {ram:"64 GiB RAM",note:"",devices:[
    {name:"NVIDIA GeForce RTX 3090",memory:"23.6 GiB VRAM"},
    {name:"AMD Radeon RX 7900 XTX",memory:"24 GiB VRAM"},
    {name:"Intel Arc A770",memory:"16 GiB VRAM"},
    {name:"Apple GPU (Metal)",memory:"18 GiB shared memory"},
    {name:"CPU",memory:null},
  ]});
  assert.equal(hardwareDetails({...info,available:false}).note,"Last detected · unable to refresh");
  assert.deepEqual(hardwareDetails({available:false}),{devices:[],ram:null,note:"Hardware unavailable"});
  assert.equal(hardwareDetails({available:true,devices:[]}).note,"Device not reported");
  assert.equal(hardwareDetails(null).note,"Detecting hardware…");
  assert.equal(hardwareDetails({devices:[{name:"GPU",type:"cuda",vram_total:null}]}).devices[0].memory,null);
});

test("hardware labels tolerate missing or malformed metadata restored from setup drafts", () => {
  assert.deepEqual(hardwareDetails({available:true,devices:"old format",ram_total:"64GB"}),
    {devices:[],ram:null,note:"Device not reported"});
  assert.deepEqual(hardwareDetails({available:true,devices:[null,{},42,{name:123,type:"cuda"},{name:"CPU",type:null}]}),
    {devices:[{name:"CUDA",memory:null},{name:"CPU",memory:null}],ram:null,note:""});
});

test("node setup accepts pasted addresses and normalizes duplicate endpoints", () => {
  assert.equal(nodeAddress(" 192.168.1.20:8188/ "), "http://192.168.1.20:8188");
  assert.equal(nodeAddress("http://192.168.1.20"), nodeAddress("192.168.1.20:80"));
  assert.equal(nodeAddress("https://[fd00::1]/"), "https://[fd00::1]:443");
  for (const value of ["", "not an address", "ftp://192.168.1.20", "http://user:pass@192.168.1.20", "http://192.168.1.20/page", "http://192.168.1.20?q=1", "http://192.168.1.20/#page"]) {
    assert.throws(() => nodeAddress(value), undefined, value);
  }
});

test("optional node names remain unique as nodes are added and removed", () => {
  const workers = [{ id: "node-1" }, { id: "node-3" }, { id: "Studio-PC" }];
  assert.equal(nodeName("", workers), "node-2");
  assert.equal(nodeName("  Living Room  ", workers), "Living-Room");
  assert.throws(() => nodeName("Studio PC", workers), /already/);
  assert.throws(() => nodeName("name/with/path", workers), /short name/);
  assert.throws(() => nodeName("a".repeat(65), workers), /short name/);
});

test("GPU name suggestions use readable labels and avoid existing node names", () => {
  const info = {devices:[{name:"cpu",type:"cpu"},
    {name:"cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync",type:"cuda"},
    {name:"cuda:1 NVIDIA GeForce RTX 4090 : cudaMallocAsync",type:"cuda"}]};
  assert.equal(suggestedNodeName(info,[]),"NVIDIA GeForce RTX 3090");
  const workers = [{id:"NVIDIA-GeForce-RTX-3090"},{id:"NVIDIA-GeForce-RTX-3090-2"}];
  assert.equal(suggestedNodeName(info,workers),"NVIDIA GeForce RTX 3090 3");
  assert.equal(suggestedNodeName({devices:[{name:"mps",type:"mps"}]},[]),"Apple GPU Metal");
  const longName = {devices:[{name:`cuda:0 ${"GPU ".repeat(30)}(TM) / device`,type:"cuda"}]};
  const first = suggestedNodeName(longName,[]);
  const second = suggestedNodeName(longName,[{id:nodeName(first,[])}]);
  assert(first.length <= 64 && second.length <= 64);
  assert.notEqual(nodeName(first,[]),nodeName(second,[]));
  assert.match(second,/ 2$/);
});

test("name suggestions leave unknown hardware and CPU-only nodes unnamed", () => {
  for (const info of [null,{}, {devices:"malformed"}, {devices:[null,{},42,{name:123}]},
    {devices:[{name:"cpu",type:"cpu"}]}, {devices:[{name:"CPU"}]},
    {available:false,devices:[{name:"NVIDIA GeForce RTX 3090",type:"cuda"}]}]) {
    assert.equal(suggestedNodeName(info,[]),"");
  }
});

test("node activity omits finished history and other nodes but preserves work needing attention", () => {
  const job = (id, changes = {}) => ({ id, batch_id: id, ordinal: 0, created: 1,
    state: "succeeded", collection_state: "collected", worker_id: "node-1", ...changes });
  const jobs = [job("unknown", { state: "unknown", occupied: 0 }),
    job("collecting", { collection_state: "pending" }),
    job("save-error", { collection_state: "error" }),
    job("queued", { state: "waiting", worker_id: null }),
    job("working", { state: "outstanding", occupied: 1 }),
    job("other-node", { state: "outstanding", occupied: 1, worker_id: "node-2" }),
    job("cancelled", { state: "cancelled", collection_state: "not_applicable" }),
    job("hidden", { hidden: true }),
    ...Array.from({ length: 200 }, (_, i) => job(`done-${i}`, { created: i + 2 }))];
  assert.deepEqual(new Set(workerJobs(jobs, "node-1").map(job => job.id)),
    new Set(["collecting", "save-error", "working"]));
});

test("the queue preserves server priority and excludes any assigned or completed work", () => {
  const jobs = [{id:"front",state:"waiting",worker_id:null,occupied:0,submit_intent:0},
    {id:"assigned",state:"preparing",worker_id:"node-1",occupied:1},
    {id:"later",state:"waiting",worker_id:null,occupied:0,submit_intent:0},
    {id:"finished",state:"cancelled",worker_id:null,occupied:0}];
  assert.deepEqual(queuedJobs(jobs).map(job => job.id), ["front", "later"]);
  jobs[0].state = "preparing";jobs[0].worker_id = "node-2";jobs[0].occupied = 1;
  assert.deepEqual(queuedJobs(jobs).map(job => job.id), ["later"]);
});

test("queue counts survive history clearing and do not double count retained history", () => {
  const live = {id:"waiting",batch_id:"batch",state:"waiting",worker_id:null,created:10};
  const finished = {id:"finished",batch_id:"batch",state:"succeeded",created:10};
  const counts = {batch:{total:16,completed:6,failed:1,cancelled:2,review:0}};
  for (const jobs of [[live], [finished,live]]) {
    const [batch] = queuedBatches(jobs,{batch:"Portraits"},counts);
    assert.equal(batch.total,16);assert.equal(batch.completed,6);
    assert.equal(batch.failed,1);assert.equal(batch.cancelled,2);
    assert.equal(batch.queued,1);assert.equal(batch.name,"Portraits");
  }
});

test("queue groups submissions, counts the full batch, and follows waiting-job priority", () => {
  const jobs = Array.from({length:16},(_,ordinal)=>({id:`a${ordinal}`,batch_id:"a",ordinal,created:10,
    state:ordinal<6 ? "succeeded" : ordinal<10 ? "outstanding" : "waiting", worker_id:ordinal<10?"node-1":null}));
  jobs.push(...Array.from({length:16},(_,ordinal)=>({id:`b${ordinal}`,batch_id:"b",ordinal,created:20,state:"waiting"})));
  jobs.push({id:"old",batch_id:"old",created:1,state:"succeeded"});
  assert.deepEqual(queuedBatches(jobs,{a:"Portraits",b:"Landscapes"}),[
    {id:"a",name:"Portraits",total:16,completed:6,failed:0,cancelled:0,active:4,queued:6,review:0,created:10},
    {id:"b",name:"Landscapes",total:16,completed:0,failed:0,cancelled:0,active:0,queued:16,review:0,created:20}
  ]);
  const reordered = [...jobs.filter(job=>job.batch_id==="b"),...jobs.filter(job=>job.batch_id!=="b")];
  assert.deepEqual(queuedBatches(reordered).map(batch=>batch.id),["b","a"]);
  jobs[0].state="failed";jobs[1].state="cancelled";jobs[6].state="unknown";
  const summary=queuedBatches(jobs)[0];
  assert.deepEqual([summary.completed,summary.failed,summary.cancelled,summary.review,summary.active],[4,1,1,1,3]);
});

test("preparation remembers the submitted workflow name without editing the graph metadata", async () => {
  const workflow={extra:{keep:"metadata",fleet:{other:"preserved"}}};
  const activeWorkflow={filename:"Portraits.json"};
  const app={rootGraph:{nodes:[]},extensionManager:{workflow:{activeWorkflow}},
    graphToPrompt:async()=>{activeWorkflow.filename="Another tab.json";return {output:{},workflow}},canvas:{draw(){}}};
  const jobs=await prepareSnapshots(app,()=>{},2);
  assert(jobs.every(job=>job.workflow.extra.fleet.workflow_name==="Portraits"));
  assert.deepEqual(workflow,{extra:{keep:"metadata",fleet:{other:"preserved"}}});
  assert.equal(jobs[0].workflow.extra.fleet.other,"preserved");
});

test("cancelled unassigned jobs are cancelled, while incomplete outputs need attention", () => {
  assert.equal(jobStatus({ state: "cancelled", worker_id: null, collection_state: "not_applicable" }), "Cancelled");
  assert.equal(jobStatus({ state: "succeeded", collection_state: "pending" }), "Saving results");
  assert.equal(jobStatus({ state: "succeeded", collection_state: "error" }), "Results need attention");
  assert.equal(jobStatus({ state: "unknown", occupied: 0 }), "Cancelled");
  assert.equal(jobStatus({ state: "unknown", occupied: 1 }), "Checking job");
});

test("native Run constructs distinct batch IDs on plain HTTP without randomUUID", () => {
  // Exercise the actual submission expression with the API available on HTTP.
  const source = readFileSync(new URL('../web/fleet.js', import.meta.url), 'utf8');
  const statement = source.match(/const body = \{ batch_id:.*?;/)[0];
  const crypto = { getRandomValues: values => webcrypto.getRandomValues(values) };
  const jobs = [{ output: {}, workflow: {} }];
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    const body = runInNewContext(statement + '\nbody', {
      crypto, jobs, source: {nodes: []}, args: [-1], createBatchId: () => preparation.createBatchId(crypto),
    });
    assert.match(body.batch_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(body.front, true);
    assert.equal(body.jobs, jobs);
    ids.add(body.batch_id);
  }
  assert.equal(ids.size, 100);
});

test("selected job isolates foreign terminal/progress and cleans up on disposal", () => {
  const events = [];
  const bridge = new SelectedJob((type, detail) => events.push({type, detail}));
  bridge.select("a", {}, false);
  assert(!events.some(e => e.type === "execution_start"), "waiting jobs must not be presented as started");
  bridge.accept({job_id:"a", type:"execution_start", detail:{prompt_id:"a"}});
  assert(!bridge.accept({job_id:"b",type:"execution_success",detail:{prompt_id:"b"}}));
  bridge.accept({job_id:"a",type:"progress",detail:{prompt_id:"a",value:2,max:10}});
  bridge.select("b", {execution_start:{prompt_id:"b"},progress:{prompt_id:"b",value:4,max:10}});
  assert.equal(events.at(-1).detail.prompt_id, "b");
  assert(!bridge.accept({job_id:"a",type:"progress",detail:{prompt_id:"a",value:9,max:10}}));
  assert.equal(bridge.selected,"b");
  bridge.dispose();
  assert.equal(events.at(-1).type,"executing");
  assert.equal(events.at(-1).detail,null);
});

test("selected job ignores image preview events", () => {
  const events=[];
  const bridge = new SelectedJob((type,detail)=>events.push({type,detail}));
  bridge.select("a");
  events.length=0;
  for(const type of ["fleet_preview","b_preview","b_preview_with_metadata"]){
    assert.equal(bridge.accept({job_id:"a",type,detail:{prompt_id:"a"}}),false);
  }
  assert.deepEqual(events,[]);
});

test("selecting a completed job cannot replay its old progress", () => {
  const events = [];
  const bridge = new SelectedJob((type, detail) => events.push({type, detail}));
  bridge.select("a", {execution_start:{prompt_id:"a"},progress:{prompt_id:"a",value:9,max:10},
    execution_success:{prompt_id:"a"}});
  assert.deepEqual(events,[{type:"executing",detail:null}]);
});

test("preparation serializes each seed once and never touches a submit function", async () => {
  let seed=5, submits=0;
  const node={widgets:[{afterQueued:()=>seed++}]};
  const app={rootGraph:{nodes:[node]},graphToPrompt:async()=>({output:{sampler:{inputs:{seed}}},workflow:{}}),
    canvas:{draw(){}},queuePrompt(){submits++}};
  const result=await prepareSnapshots(app,()=>{},3);
  assert.deepEqual(result.map(r=>r.output.sampler.inputs.seed),[5,6,7]);
  assert.equal(seed,8);assert.equal(submits,0);
});

for (const location of ["output", "workflow"]) {
  test(`preparation snapshots uploaded images with nested ${location} proxies`, async () => {
    const inputs = { image: "uploads/browser-image.png [input]", seed: 5 };
    const values = [inputs.image, inputs.seed];
    const snapshot = {
      output: { "1": { class_type: "LoadImage", inputs } },
      workflow: { nodes: [{ id: 1, type: "LoadImage", widgets_values: values }] },
    };
    if (location === "output") snapshot.output["1"].inputs = new Proxy(inputs, {});
    else snapshot.workflow.nodes[0].widgets_values = new Proxy(values, {});
    let submitted = 0;
    const prepared = [];
    const app = {
      rootGraph: { nodes: [{ widgets: [{ afterQueued() {
        inputs.seed++;
        values[1]++;
      } }] }] },
      graphToPrompt: async () => snapshot,
      canvas: { draw() {} },
      queuePrompt() { submitted++; },
    };
    const jobs = await prepareSnapshots(app, () => {}, 2, count => prepared.push(count));
    assert.deepEqual(prepared, [1, 2]);
    assert.deepEqual(jobs.map(job => job.output["1"].inputs.seed), [5, 6]);
    assert.deepEqual(jobs.map(job => job.workflow.nodes[0].widgets_values[1]), [5, 6]);
    for (const job of jobs) {
      assert.equal(job.output["1"].inputs.image, "uploads/browser-image.png [input]");
      assert.equal(job.workflow.nodes[0].widgets_values[0], "uploads/browser-image.png [input]");
      assert.doesNotThrow(() => structuredClone(job), "prepared snapshots must be plain data");
    }
    inputs.image = values[0] = "later-upload.png";
    assert.equal(jobs[0].output["1"].inputs.image, "uploads/browser-image.png [input]");
    assert.equal(jobs[0].workflow.nodes[0].widgets_values[0], "uploads/browser-image.png [input]");
    assert.equal(inputs.seed, 7);
    assert.equal(submitted, 0);
  });
}

test("authored source is captured before queue callbacks resolve prompts and advance counters", async () => {
  const values = {prompt:"{a|b}",seed:10};
  const app = {
    extensionManager:{workflow:{activeWorkflow:{filename:"Production.json"}}},
    rootGraph:{serialize:()=>({nodes:[{widgets_values:[values.prompt,values.seed]}]}),
      nodes:[{widgets:[{beforeQueued(){values.prompt="a"},afterQueued(){values.seed++}}]}]},
    graphToPrompt:async()=>({output:{1:{class_type:"CustomPrompt",inputs:{...values}}},workflow:app.rootGraph.serialize()}),
    canvas:{draw(){}},
  };
  const source=preparation.captureSource(app);
  const jobs=await prepareSnapshots(app,()=>{},3);
  assert.deepEqual(source.nodes[0].widgets_values,["{a|b}",10]);
  assert.deepEqual(jobs.map(job=>job.output[1].inputs.seed),[10,11,12]);
  assert(jobs.every(job=>job.output[1].inputs.prompt==="a"));
  assert.equal(source.extra.fleet.workflow_name,"Production");
});
