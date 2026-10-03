// Real browser extension -> real Fleet HTTP/controller/SQLite -> stock-worker HTTP fixtures.
// No production routes, ledger methods, or panel actions are mocked.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const {chromium}=createRequire(import.meta.url)(process.env.FLEET_PLAYWRIGHT_MODULE || "playwright");

async function confirmCancellation(page) {
  await page.getByRole("dialog").getByRole("button",{name:/^Cancel /}).click();
}

async function setup(t, {nodeCount=2,toast="native"}={}) {
  const server=spawn(process.env.FLEET_PYTHON || ".venv/bin/python",["tests/e2e_server.py",String(nodeCount)]);
  let browser;
  let stderr="";server.stderr.on("data",data=>{stderr+=data});
  const lines=createInterface({input:server.stdout});
  const errors=[];
  t.after(async()=>{
    await browser?.close();
    if(server.exitCode===null&&server.signalCode===null){
      const exited=once(server,"exit");server.kill("SIGTERM");
      const force=setTimeout(()=>server.kill("SIGKILL"),5000);
      await exited;clearTimeout(force);
    }
    lines.close();assert.deepEqual(errors,[]);assert.equal(stderr,"");
  });
  const ready=await Promise.race([
    once(lines,"line").then(([line])=>JSON.parse(line)),
    once(server,"exit").then(()=>{throw new Error(`Fixture failed: ${stderr}`)}),
  ]);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:700,height:1000}});
  page.setDefaultTimeout(10000);
  page.on("pageerror",error=>errors.push(error.message));
  const post=async(path,data={})=>{
    const response=await page.request.post(ready.url+path,{data});
    assert.equal(response.ok(),true,await response.text());return response.json();
  };
  const state=async()=>(await page.request.get(ready.url+"/fleet/state")).json();
  const fixture=async()=>(await page.request.get(ready.url+"/fixture")).json();
  await page.goto(`${ready.url}/?toast=${toast}`);
  await page.getByRole("button",{name:"Manage nodes",exact:true}).waitFor();
  const submit=async(name,count)=>{
    await page.getByRole("textbox",{name:"Workflow",exact:true}).fill(name+".json");
    await page.getByRole("spinbutton",{name:"Jobs",exact:true}).fill(String(count));
    const accepted=page.waitForResponse(response=>response.url().endsWith("/fleet/batches")&&response.request().method()==="POST");
    await page.getByRole("button",{name:"Run",exact:true}).click();
    const response=await accepted;assert.equal(response.ok(),true,await response.text());
    return response.json();
  };
  const until=async(predicate)=>{
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){const value=await state();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,50));}
    assert.fail(`State did not converge: ${JSON.stringify(await state())}`);
  };
  return {page,post,state,fixture,submit,until};
}

test("explicit interrupt cancels the requested job while another job is selected", {timeout:30000}, async t => {
  const {page,submit,until,state}=await setup(t);
  await submit("landscaping",2);
  const current=await until(s=>s.jobs.filter(job=>job.acknowledged).length===2);
  await page.evaluate(()=>window.comfyFleet.refresh());
  const selected=await page.evaluate(()=>window.comfyFleet.snapshot().selected);
  assert(selected);
  const requested=current.jobs.find(job=>job.id!==selected);
  await page.evaluate(async id=>{
    const {api}=await import('/scripts/api.js');
    await api.interrupt(id);
  },requested.id);
  const after=await state();
  assert.equal(after.jobs.find(job=>job.id===requested.id).cancel_requested,1);
  assert.equal(after.jobs.find(job=>job.id===selected).cancel_requested,0);
});

test("accepted jobs use a dismissible native Fleet notification instead of persistent panel text",{timeout:45000},async t=>{
  const {page,submit}=await setup(t);
  await page.clock.install();
  await submit("Portraits",4);
  const detail="Accepted 4 jobs. Work will continue if this browser closes.";
  const notifications=page.getByRole("region",{name:"Notifications",exact:true});
  await notifications.getByText(detail,{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.nativeNotifications),[
    {severity:"success",summary:"Fleet",detail,life:5000,closable:true},
  ]);
  assert.equal(await page.locator(".fleet-panel").getByText(detail,{exact:true}).count(),0);
  await page.clock.fastForward(5001);
  await notifications.getByText(detail,{exact:true}).waitFor({state:"hidden"});
  await page.evaluate(()=>window.comfyFleet.refresh());
  assert.equal(await page.evaluate(()=>window.nativeNotifications.length),1,"Polling must not replay notifications");
  await submit("Another batch",1);
  await notifications.getByRole("button",{name:"Close notification",exact:true}).click();
  assert.equal(await notifications.getByRole("status").count(),0);
});

test("setup scrolls with the mouse wheel inside ComfyUI's sidebar wrapper",{timeout:30000},async t=>{
  const {page}=await setup(t,{nodeCount:8});
  await page.setViewportSize({width:700,height:520});
  await page.getByRole("button",{name:"Manage nodes",exact:true}).click();
  const area=page.locator(".fleet-setup-content"),panel=page.locator(".fleet-panel");
  const done=page.getByRole("button",{name:"Done",exact:true});
  const before=await done.boundingBox();
  const box=await area.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+80);
  await page.mouse.wheel(0,400);
  await page.waitForFunction(()=>document.querySelector('.fleet-setup-content').scrollTop>0,null,{timeout:2000});
  assert.equal((await done.boundingBox()).y,before.y);
  assert(before.y+before.height<=520,"Done must remain inside the visible sidebar");
  assert.equal(await page.locator(".sidebar-content-container").evaluate(el=>el.scrollTop),0);
  assert.equal(await panel.evaluate(el=>el.scrollTop),0);
  await page.mouse.wheel(0,-800);
  await page.waitForFunction(()=>document.querySelector('.fleet-setup-content').scrollTop===0,null,{timeout:2000});
  await done.click();
  await page.getByRole("button",{name:"Manage nodes",exact:true}).waitFor();
  const nodeBox=await page.locator(".fleet-worker").first().boundingBox();
  await page.mouse.move(nodeBox.x+nodeBox.width/2,nodeBox.y+20);
  await page.mouse.wheel(0,400);
  await page.waitForFunction(()=>document.querySelector('.fleet-panel').scrollTop>0,null,{timeout:2000});
});

test("setup keeps Done pinned while a long node list scrolls and Cancel only dismisses the new-node form",{timeout:45000},async t=>{
  const {page,state}=await setup(t,{nodeCount:12});
  const before=(await state()).workers;
  await page.setViewportSize({width:700,height:520});
  await page.getByRole("button",{name:"Manage nodes",exact:true}).click();
  const done=page.getByRole("button",{name:"Done",exact:true});
  const scroller=page.locator(".fleet-setup-content");
  const visibleDone=async()=>{
    assert.equal(await done.evaluate(button=>{
      const rect=button.getBoundingClientRect();
      return rect.top>=0&&rect.bottom<=innerHeight&&document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===button;
    }),true,"Done must stay on screen and clickable without scrolling");
    assert.equal(await page.locator(".fleet-panel").evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    return done.boundingBox();
  };
  const initial=await visibleDone();
  assert.equal(await scroller.evaluate(el=>el.scrollHeight>el.clientHeight),true);
  await page.getByRole("button",{name:"Add node",exact:true}).scrollIntoViewIfNeeded();
  assert.equal(await scroller.evaluate(el=>el.scrollTop>0),true);
  assert.equal((await visibleDone()).y,initial.y,"Scrolling the list must not move Done");
  const cancel=page.getByRole("button",{name:"Cancel",exact:true});
  const add=page.getByRole("button",{name:"Add node",exact:true});
  const addBox=await add.boundingBox(),cancelBox=await cancel.boundingBox();
  assert.equal(addBox.y,cancelBox.y);assert.equal(addBox.height,cancelBox.height);
  assert(addBox.width>cancelBox.width,"Add node takes more of the action row");
  const cancelStyle=await cancel.evaluate(el=>({border:getComputedStyle(el).borderTopWidth,color:getComputedStyle(el).color}));
  assert.equal(cancelStyle.border,"1px");assert.notEqual(cancelStyle.color,"rgb(242, 166, 166)");
  await page.getByRole("textbox",{name:"Name (optional)",exact:true}).fill("Unfinished node");
  await done.click();
  await page.getByText("Add this node or choose Cancel before clicking Done.",{exact:true}).waitFor();
  await visibleDone();
  await cancel.click();
  assert.deepEqual((await state()).workers,before,"Cancel must not change saved nodes");
  await page.getByRole("button",{name:"Add another node",exact:true}).click();
  assert.equal(await page.getByRole("textbox",{name:"Name (optional)",exact:true}).inputValue(),"");
  for(const height of [800,420]){
    await page.setViewportSize({width:700,height});
    await visibleDone();
    await scroller.evaluate(el=>{el.scrollTop=0});await visibleDone();
    await cancel.scrollIntoViewIfNeeded();await visibleDone();
  }
  if(process.env.FLEET_E2E_SCREENSHOTS){
    await page.setViewportSize({width:700,height:800});await cancel.scrollIntoViewIfNeeded();
    await mkdir(process.env.FLEET_E2E_SCREENSHOTS,{recursive:true});
    await page.locator(".fleet-panel").screenshot({path:join(process.env.FLEET_E2E_SCREENSHOTS,"setup-pinned-footer.png")});
  }
  await cancel.click();await done.click();
  await page.getByRole("button",{name:"Manage nodes",exact:true}).waitFor();
  assert.deepEqual((await state()).workers,before);
  assert.equal(await page.locator(".fleet-setup-footer").isVisible(),false);
});

test("discarding setup edits requires confirmation and keeps the saved node configuration",{timeout:45000},async t=>{
  const {page,state}=await setup(t);
  const before=(await state()).workers;
  const manage=page.getByRole("button",{name:"Manage nodes",exact:true});
  const discard=page.locator(".fleet-setup-footer").getByRole("button",{name:"Discard changes",exact:true});
  const name=page.getByRole("textbox",{name:"Name (optional)",exact:true});
  await manage.click();
  assert.equal(await discard.isVisible(),false,"An unchanged setup has nothing to discard");
  await name.fill("Unfinished node");await discard.waitFor();await page.mouse.move(0,0);
  const style=await discard.evaluate(el=>{
    const css=getComputedStyle(el);
    return {color:css.color,border:parseFloat(css.borderTopWidth),height:el.getBoundingClientRect().height};
  });
  assert.equal(style.color,"rgb(242, 166, 166)");
  assert(style.border>=1&&style.height>=36,"Discard must look like an outlined button");
  await discard.click();
  const dialog=page.getByRole("dialog",{name:"Discard unsaved changes?",exact:true});
  await dialog.getByText("Your unsaved node changes and any unfinished node details will be lost. Your saved nodes and running jobs will stay unchanged.",{exact:true}).waitFor();
  assert.equal(await dialog.getByRole("button",{name:"Keep editing",exact:true}).evaluate(el=>el===document.activeElement),true);
  await dialog.getByRole("button",{name:"Keep editing",exact:true}).click();
  assert.equal(await name.inputValue(),"Unfinished node");
  await discard.click();await page.keyboard.press("Escape");
  assert.equal(await name.inputValue(),"Unfinished node");
  await name.fill("");assert.equal(await discard.isVisible(),false,"Undoing an edit hides Discard again");
  await page.getByRole("button",{name:"Remove Node 2",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"Remove node",exact:true}).click();
  await discard.waitFor();
  assert.deepEqual((await state()).workers,before);
  // The draft and its confirmation must also work after a browser reload.
  await page.reload();await discard.waitFor();
  assert.equal(await page.getByRole("button",{name:"Remove Node 2",exact:true}).count(),0);
  await discard.click();
  if(process.env.FLEET_E2E_SCREENSHOTS){
    await mkdir(process.env.FLEET_E2E_SCREENSHOTS,{recursive:true});
    await page.screenshot({path:join(process.env.FLEET_E2E_SCREENSHOTS,"discard-setup-confirmation.png")});
  }
  await dialog.getByRole("button",{name:"Discard changes",exact:true}).click();
  await manage.waitFor();
  assert.deepEqual((await state()).workers,before,"Discard must never save the draft configuration");
  assert.deepEqual(await page.evaluate(()=>window.nativeNotifications),[],"Discard needs no success notification");
  assert.equal(await page.locator(".fleet-node-list").textContent(),"","Discarded node drafts must leave the hidden DOM");
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith("comfyui-fleet:setup:"))),[]);
  await page.reload();await manage.waitFor();
  await manage.click();
  assert.equal(await discard.isVisible(),false);
  await page.getByRole("button",{name:"Remove Node 2",exact:true}).waitFor();
});

test("finished jobs leave SQLite, normal history works, counts survive restart, and every node can be removed",{timeout:60000},async t=>{
  const {page,post,state,submit,until}=await setup(t);
  let admission;
  page.on("request",request=>{if(request.url().endsWith("/fleet/batches")&&request.method()==="POST")admission=request.postDataJSON()});
  const accepted=await submit("Portraits",4);
  let current=await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  const finished=current.jobs.find(j=>j.occupied);
  await post("/fixture",{worker:finished.worker_id,complete:finished.remote_id,with_results:true});
  await until(s=>s.jobs.some(j=>j.id===finished.id&&j.collection_state==="collected"));
  const storage=async()=>(await page.request.get(new URL("/fixture/storage",page.url()).href)).json();
  const waitStorage=async(count)=>{
    for(let i=0;i<100;i++){if((await storage()).jobs===count)return;await new Promise(resolve=>setTimeout(resolve,50));}
    assert.equal((await storage()).jobs,count);
  };
  await waitStorage(3);
  await page.getByText("1 of 4 jobs completed",{exact:true}).waitFor();
  const native=async(path,options)=>page.evaluate(async({path,options})=>{
    const {api}=await import("/scripts/api.js");
    const response=await api.fetchApi(path,options);
    return {status:response.status,body:await response.json()};
  },{path,options});
  const detail=await native(`/jobs/${finished.id}`);
  assert.equal(detail.status,200);assert.equal(detail.body.status,"completed");
  assert.equal(detail.body.workflow.extra_data.extra_pnginfo.workflow.extra.fleet.workflow_name,"Portraits");
  const ref=detail.body.outputs["1"].images[0];
  const output=new URL("/view",page.url());output.search=new URLSearchParams(ref).toString();
  const image=await page.request.get(output.href);assert.equal(image.ok(),true);
  assert.deepEqual([...((await image.body()).subarray(0,8))],[137,80,78,71,13,10,26,10]);
  assert((await native("/jobs")).body.jobs.some(job=>job.id===finished.id));
  await native("/history",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({delete:[finished.id]})});
  assert(!(await native("/jobs")).body.jobs.some(job=>job.id===finished.id));
  assert.equal((await state()).batch_counts[accepted.batch_id].completed,1);
  await post("/fixture",{restart:true});
  await page.reload();
  await page.getByText("1 of 4 jobs completed",{exact:true}).waitFor();
  assert.equal((await state()).batch_names[accepted.batch_id],"Portraits");
  assert(!(await native("/jobs")).body.jobs.some(job=>job.id===finished.id));
  const replay=await post("/fleet/batches",admission);
  assert.deepEqual(replay.job_ids,accepted.job_ids);assert.equal(replay.replayed,true);
  assert.equal((await storage()).jobs,3);
  await page.getByRole("button",{name:"Cancel queued jobs",exact:true}).click();await confirmCancellation(page);
  await page.getByRole("button",{name:"Cancel active jobs",exact:true}).click();await confirmCancellation(page);
  await waitStorage(0);
  assert.equal((await storage()).batch_progress,0);
  assert.equal((await storage()).batch_receipts,1,"Only the admission receipt remains");
  await page.getByRole("button",{name:"Manage nodes",exact:true}).click();
  for(const name of ["Node 1","Node 2"]){
    await page.getByRole("button",{name:`Remove ${name}`,exact:true}).click();
    await page.getByRole("dialog").getByRole("button",{name:"Remove node",exact:true}).click();
  }
  await page.getByRole("button",{name:"Done",exact:true}).click();
  await until(s=>s.workers.length===0);
  assert.equal(await page.locator(".fleet-setup-error").isVisible(),false);
  assert.equal((await page.request.get(output.href)).ok(),true,"Removing nodes never removes results");
});

for(const withFleet of [false,true]) test(`clearing history removes native controller data ${withFleet ? "alongside Fleet jobs" : "without Fleet jobs"}`,{timeout:30000},async t=>{
  const {page,post,state,fixture,submit,until}=await setup(t,{nodeCount:1});
  const localId="00000000-0000-4000-8000-000000000001";
  await post("/fixture",{native_history:[{id:localId,status:"completed",create_time:1,
    workflow:{prompt:{text:"A synthetic landscaping prompt"}},outputs:[]}]});
  let finished,accepted;
  if(withFleet){
    accepted=await submit("landscaping",3);
    finished=(await until(s=>s.jobs.some(j=>j.acknowledged))).jobs.find(j=>j.occupied);
    await post("/fixture",{worker:finished.worker_id,complete:finished.remote_id});
    await until(s=>s.jobs.some(j=>j.id===finished.id&&j.collection_state==="collected")&&
      s.jobs.some(j=>j.id!==finished.id&&j.acknowledged));
  }
  await page.evaluate(()=>window.comfyFleet.refresh());
  const jobs=async()=>(await page.request.get(new URL("/fleet/jobs",page.url()).href)).json();
  const before=await jobs(),workers=await fixture();
  assert(before.jobs.some(job=>job.id===localId));
  if(withFleet){
    assert(before.jobs.some(job=>job.id===finished.id));
    assert(workers[finished.worker_id].history.includes(finished.remote_id));
  }
  const cleared=await page.evaluate(async path=>{
    const {api}=await import("/scripts/api.js");
    const response=await api.fetchApi(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clear:true})});
    return response.status;
  },withFleet ? "/api/history" : "/history");
  assert.equal(cleared,200);
  const after=await jobs();
  assert(!after.jobs.some(job=>job.id===localId),"Clear history must remove native controller jobs");
  assert.equal((await page.request.get(new URL(`/fleet/jobs/${localId}`,page.url()).href)).status(),404,
    "The cleared native prompt must no longer be retrievable by ID");
  assert.deepEqual(await fixture(),workers,"Clearing controller history must preserve remote histories and active jobs");
  if(withFleet){
    assert(!after.jobs.some(job=>job.id===finished.id));
    assert.equal(after.jobs.length,2,"Active and queued Fleet jobs remain");
    assert.equal((await state()).batch_counts[accepted.batch_id].completed,1);
  }
});

test("clearing history returns native controller failures instead of reporting success",{timeout:30000},async t=>{
  const {page}=await setup(t);
  await page.route("**/history",route=>route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"History unavailable"})}));
  const response=await page.evaluate(async()=>{
    const {api}=await import("/scripts/api.js");
    const result=await api.fetchApi("/history",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clear:true})});
    return {status:result.status,body:await result.json()};
  });
  assert.deepEqual(response,{status:503,body:{error:"History unavailable"}});
});

test("clearing the native queue cancels waiting Fleet jobs without clearing worker queues",{timeout:30000},async t=>{
  const {page,submit,until,fixture}=await setup(t,{nodeCount:1});
  await submit("landscaping",3);
  await until(s=>s.jobs.some(j=>j.acknowledged));
  await page.evaluate(()=>window.comfyFleet.refresh());
  const workers=await fixture();
  const status=await page.evaluate(async()=>{
    const {api}=await import("/scripts/api.js");
    return (await api.fetchApi("/queue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clear:true})})).status;
  });
  assert.equal(status,200,"The native controller has no global queue-clear fixture endpoint");
  const current=await until(s=>!s.jobs.some(j=>j.state==="waiting"));
  assert.equal(current.jobs.filter(j=>j.occupied).length,1);
  assert.deepEqual(await fixture(),workers,"Both active Fleet work and unrelated native work stay on workers");
});

test("removing a busy node shows a styled explanation, keeps configuration atomic, and can be retried",{timeout:45000},async t=>{
  const {page,post,state,submit,until}=await setup(t,{nodeCount:1});
  await submit("Portraits",1);
  const current=await until(s=>s.jobs.some(j=>j.acknowledged));
  const running=current.jobs.find(j=>j.occupied);
  await page.getByRole("button",{name:"Manage nodes",exact:true}).click();
  await page.getByRole("button",{name:"Remove Node 1",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"Remove node",exact:true}).click();
  await page.getByRole("button",{name:"Done",exact:true}).click();
  const error=page.locator(".fleet-setup-error");
  await error.getByText("Changes haven’t been saved",{exact:true}).waitFor();
  assert.match(await error.innerText(),/active job or results to collect/);
  assert.match(await error.innerText(),/disable the node/);
  assert.equal(await error.evaluate(el=>getComputedStyle(el).borderRadius),"10px");
  assert.equal((await state()).workers.length,1);
  if(process.env.FLEET_E2E_SCREENSHOTS){
    await mkdir(process.env.FLEET_E2E_SCREENSHOTS,{recursive:true});
    await page.locator(".fleet-panel").screenshot({path:join(process.env.FLEET_E2E_SCREENSHOTS,"node-removal-blocked.png")});
  }
  await post("/fixture",{worker:running.worker_id,complete:running.remote_id});
  await until(s=>s.jobs.some(j=>j.id===running.id&&j.collection_state==="collected"));
  await page.getByRole("button",{name:"Done",exact:true}).click();
  await until(s=>s.workers.length===0);
  assert.equal(await error.isVisible(),false);
});

test("adding and removing nodes stays silent and changes remain drafts until Done",{timeout:45000},async t=>{
  const {page,state}=await setup(t);
  const before=(await state()).workers;
  const notices=page.getByRole("region",{name:"Notifications",exact:true});
  await page.getByRole("button",{name:"Manage nodes",exact:true}).click();
  await page.getByRole("button",{name:"Remove Node 2",exact:true}).click();
  await page.getByRole("dialog",{name:'Remove “Node 2”?',exact:true}).getByRole("button",{name:"Remove node",exact:true}).click();
  await page.getByRole("button",{name:"Remove Node 2",exact:true}).waitFor({state:"hidden"});
  assert.deepEqual((await state()).workers,before);
  assert.equal(await notices.getByRole("status").count(),0);
  await page.getByRole("textbox",{name:"ComfyUI address",exact:true}).fill(before[1].url);
  await page.getByRole("textbox",{name:"Name (optional)",exact:true}).fill("Replacement");
  await page.getByRole("button",{name:"Add node",exact:true}).click();
  await page.getByRole("button",{name:"Remove Replacement",exact:true}).waitFor();
  assert.equal(await notices.getByRole("status").count(),0);
  assert.equal(await page.evaluate(()=>window.nativeNotifications.length),0,"Neither adding nor removing nodes needs a notification");
  assert.deepEqual((await state()).workers,before);
  await page.getByRole("button",{name:"Done",exact:true}).click();
  await page.getByRole("switch",{name:"Replacement",exact:true}).waitFor();
  assert.deepEqual((await state()).workers.map(w=>w.id),["node-1","Replacement"]);
  await page.getByRole("button",{name:"Manage nodes",exact:true}).click();
  await page.getByRole("button",{name:"Remove Replacement",exact:true}).click();
  await page.getByRole("dialog",{name:'Remove “Replacement”?',exact:true}).getByRole("button",{name:"Remove node",exact:true}).click();
  await page.getByRole("button",{name:"Remove Replacement",exact:true}).waitFor({state:"hidden"});
  await page.getByRole("button",{name:"Discard changes",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"Discard changes",exact:true}).click();
  assert.equal(await page.getByRole("switch",{name:"Replacement",exact:true}).isVisible(),true);
  assert.equal(await notices.getByRole("status").count(),0);
  assert.equal(await page.evaluate(()=>window.nativeNotifications.length),0,"Confirmed removals must not create a second notification");
});

test("removing the first draft node requires confirmation through a visible red button",{timeout:45000},async t=>{
  const {page,post,state}=await setup(t,{nodeCount:1});
  const address=(await state()).workers[0].url;
  await post("/fleet/workers",{workers:[]});await page.reload();
  await page.getByRole("textbox",{name:"ComfyUI address",exact:true}).fill(address);
  await page.getByRole("textbox",{name:"Name (optional)",exact:true}).fill("Studio");
  await page.getByRole("button",{name:"Add node",exact:true}).click();
  const remove=page.getByRole("button",{name:"Remove Studio",exact:true});
  await remove.waitFor();await page.mouse.move(0,0);
  assert.deepEqual(await page.evaluate(()=>window.nativeNotifications),[],"Adding the first node is silent too");
  const style=await remove.evaluate(el=>{
    const css=getComputedStyle(el);
    return {color:css.color,border:parseFloat(css.borderTopWidth),height:el.getBoundingClientRect().height};
  });
  assert.equal(style.color,"rgb(242, 166, 166)");
  assert(style.border>=1&&style.height>=30,"Remove must have a visible button border and a comfortable click target");
  await remove.click();
  const dialog=page.getByRole("dialog",{name:'Remove “Studio”?',exact:true});
  await dialog.getByText("This removes the node from your setup list. Click Done to save the change. No jobs will be cancelled.",{exact:true}).waitFor();
  assert.equal(await dialog.getByRole("button",{name:"Keep node",exact:true}).evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.locator(".fleet-node-card").count(),1);
  assert.equal(await page.evaluate(()=>window.nativeNotifications.length),0,"Opening confirmation must not report removal");
  assert.deepEqual((await state()).workers,[]);
  if(process.env.FLEET_E2E_SCREENSHOTS){
    await mkdir(process.env.FLEET_E2E_SCREENSHOTS,{recursive:true});
    await page.screenshot({path:join(process.env.FLEET_E2E_SCREENSHOTS,"remove-node-confirmation.png")});
  }
  await dialog.getByRole("button",{name:"Keep node",exact:true}).click();
  assert.equal(await remove.isEnabled(),true);
  await remove.click();await page.keyboard.press("Escape");
  await dialog.waitFor({state:"hidden"});assert.equal(await remove.isVisible(),true);
  assert.equal(await page.evaluate(()=>window.nativeNotifications.length),0);
  await page.reload();await remove.waitFor();
  await remove.click();await dialog.getByRole("button",{name:"Remove node",exact:true}).click();
  await remove.waitFor({state:"hidden"});
  assert.deepEqual(await page.evaluate(()=>window.nativeNotifications),[],"Confirmed removal is also silent during initial setup");
  assert.equal(await page.locator(".fleet-node-card").count(),0);
  assert.equal(await page.getByRole("button",{name:"Done",exact:true}).isEnabled(),false);
  assert.deepEqual((await state()).workers,[]);
  await page.reload();await page.getByText("Add your first node",{exact:true}).waitFor();
  assert.equal(await page.locator(".fleet-node-card").count(),0);
  assert.deepEqual(await page.evaluate(()=>window.nativeNotifications),[],"Reload must not repeat a removal notification");
});

test("every job cancellation explains its scope and sends nothing until explicitly confirmed",{timeout:45000},async t=>{
  const {page,state,submit,until}=await setup(t,{nodeCount:1});
  await submit("Portraits",3);await until(s=>s.jobs.some(j=>j.acknowledged));
  await submit("Landscapes",2);
  const before=(await state()).jobs;
  const sent=[];
  page.on("request",request=>{if(request.method()==="POST"&&/\/fleet\/(queue\/cancel|jobs\/cancel(?:-active)?)$/.test(request.url()))sent.push(request.url())});
  const queue=page.getByRole("region",{name:"Queued Fleet batches",exact:true});
  const cases=[
    {button:queue.getByRole("listitem").filter({has:page.getByText("Portraits",{exact:true})}).getByRole("button",{name:"Cancel batch",exact:true}),
      title:'Cancel queued jobs in “Portraits”?',copy:/Only jobs still waiting in this batch will be cancelled\. Assigned jobs will keep running\. Other batches will not be affected\./},
    {button:page.getByRole("button",{name:"Cancel queued jobs",exact:true}),title:"Cancel all queued jobs?",
      copy:/Jobs waiting across every batch will be cancelled\. Assigned jobs will keep running\./},
    {button:page.getByRole("button",{name:"Cancel active jobs",exact:true}),title:"Cancel active jobs?",
      copy:/Queued jobs will remain and can start as nodes become free\. Cancel queued jobs first if you want all work to stop\./},
    {button:page.getByRole("button",{name:"Cancel job",exact:true}),title:'Cancel “Portraits” on Node 1?',
      copy:/Only this job will be cancelled\. Other active jobs and queued jobs will continue\./},
  ];
  for(const item of cases){
    await item.button.click();
    const dialog=page.getByRole("dialog",{name:item.title,exact:true});await dialog.waitFor();
    assert.equal(await dialog.getByText(item.copy).isVisible(),true);
    assert.equal(await dialog.getByRole("button",{name:"Keep jobs",exact:true}).evaluate(el=>el===document.activeElement),true);
    if(process.env.FLEET_E2E_SCREENSHOTS&&item.title==="Cancel active jobs?"){
      await mkdir(process.env.FLEET_E2E_SCREENSHOTS,{recursive:true});
      await page.screenshot({path:join(process.env.FLEET_E2E_SCREENSHOTS,"cancel-confirmation.png")});
    }
    await page.evaluate(()=>window.comfyFleet.refresh());
    assert.deepEqual(sent,[]);
    await dialog.getByRole("button",{name:"Keep jobs",exact:true}).click();
    await dialog.waitFor({state:"hidden"});
    await item.button.click();await page.keyboard.press("Escape");
    await dialog.waitFor({state:"hidden"});
    assert.deepEqual((await state()).jobs,before);
    assert.deepEqual(sent,[]);
  }
  await cases[0].button.click();
  await page.evaluate(()=>window.comfyFleet.dispose());
  assert.equal(await page.getByRole("dialog").count(),0);
  assert.deepEqual(sent,[],"Detaching the panel dismisses an open confirmation without cancelling jobs");
});

test("node switches notify only after a successful save and leave errors visible on failure",{timeout:45000},async t=>{
  const {page,state,submit,until}=await setup(t);
  await page.clock.install();
  await submit("Portraits",1);
  const before=await until(s=>s.jobs.some(j=>j.acknowledged));
  await page.getByText("Accepted 1 job. Work will continue if this browser closes.",{exact:true}).waitFor();
  await page.clock.fastForward(5001);
  const notices=page.getByRole("region",{name:"Notifications",exact:true});
  const toggle=page.getByRole("switch",{name:"Node 1",exact:true});
  let release,received;
  const held=new Promise(resolve=>{release=resolve}),seen=new Promise(resolve=>{received=resolve});
  await page.route("**/fleet/workers",async route=>{received();await held;await route.continue()},{times:1});
  t.after(()=>release());
  await toggle.click();await seen;
  assert.equal(await notices.getByRole("status").count(),0,"A pending save must not report success");
  assert.equal(await toggle.isEnabled(),false);
  assert.equal(Boolean((await state()).workers[0].enabled),true);
  release();await notices.getByText("Node 1 disabled. Assigned jobs keep running.",{exact:true}).waitFor();
  assert.equal(Boolean((await state()).workers[0].enabled),false);
  assert.deepEqual((await state()).jobs,before.jobs);
  await page.clock.fastForward(5001);
  await page.route("**/fleet/workers",route=>route.abort("connectionfailed"),{times:1});
  await toggle.click();
  const error=page.getByText(/^Could not save this change\./);await error.waitFor();
  await page.clock.fastForward(6000);
  assert.equal(await error.isVisible(),true);
  assert.equal(await notices.getByRole("status").count(),0);
  assert.equal(Boolean((await state()).workers[0].enabled),false);
  await toggle.click();await notices.getByText("Node 1 enabled for new jobs.",{exact:true}).waitFor();
  assert.equal(Boolean((await state()).workers[0].enabled),true);
  assert.equal(await error.count(),0);
  await page.clock.fastForward(5001);
  assert.equal(await notices.getByRole("status").count(),0);
  assert.equal(await page.evaluate(()=>window.nativeNotifications.length),3);
});

test("ordering and cancellation confirmations expire while a later action error stays visible",{timeout:45000},async t=>{
  const {page,post,submit,until}=await setup(t);
  await page.clock.install();
  await submit("Portraits",4);
  await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  await submit("Landscapes",2);
  await page.getByText("Accepted 2 jobs. Work will continue if this browser closes.",{exact:true}).waitFor();
  await page.clock.fastForward(5001);
  const notices=page.getByRole("region",{name:"Notifications",exact:true});
  const move=async(name,key)=>{
    const handle=page.getByRole("button",{name:`Reorder ${name}`,exact:true});
    await handle.focus();await handle.press("Space");await handle.press(key);await handle.press("Space");
  };
  await move("Landscapes","Home");
  await notices.getByText("Batch order saved. Active jobs keep running.",{exact:true}).waitFor();
  await move("Node 2","Home");
  await notices.getByText("Node order saved. Active jobs keep running.",{exact:true}).waitFor();
  await page.getByRole("button",{name:"Cancel queued jobs",exact:true}).click();await confirmCancellation(page);
  await notices.getByText("Cancelled 4 queued jobs.",{exact:true}).waitFor();
  await post("/fixture",{allow_cancel:false});
  await page.getByRole("button",{name:"Cancel active jobs",exact:true}).click();await confirmCancellation(page);
  await notices.getByText("Cancellation requested for 2 active jobs.",{exact:true}).waitFor();
  for(const selector of [".fleet-node-feedback",".fleet-queue-feedback",".fleet-cancel-feedback"]){
    assert.equal(await page.locator(selector).isVisible(),false,"Successful actions leave no inline residue");
  }
  await page.route("**/fleet/workers/reorder",route=>route.abort("connectionfailed"),{times:1});
  await move("Node 2","End");
  const error=page.getByText(/^Could not reorder nodes\./);
  await error.waitFor();
  await page.clock.fastForward(5001);
  await page.evaluate(()=>window.comfyFleet.refresh());
  assert.equal(await notices.getByRole("status").count(),0);
  assert.equal(await error.isVisible(),true,"Notification expiry cannot erase a newer error");
  const messages=await page.evaluate(()=>window.nativeNotifications);
  assert.equal(messages.length,6,"Two admissions and four action confirmations, with no polling duplicates");
  assert(messages.every(message=>message.life===5000&&message.closable&&message.severity==="success"));
});

test("cancelling a batch removes only its still-queued jobs, including when assignment races the click",{timeout:45000},async t=>{
  const {page,post,state,fixture,submit,until}=await setup(t);
  const first=await submit("Portraits",5);
  let current=await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  let finished=current.jobs.find(j=>j.occupied);
  await post("/fixture",{worker:finished.worker_id,complete:finished.remote_id});
  await until(s=>s.jobs.some(j=>j.state==="succeeded")&&s.jobs.filter(j=>j.acknowledged).length===3);
  const second=await submit("Landscapes",2);
  const queue=page.getByRole("region",{name:"Queued Fleet batches",exact:true});
  const portrait=queue.getByRole("listitem").filter({has:page.getByText("Portraits",{exact:true})});
  const cancel=portrait.getByRole("button",{name:"Cancel batch",exact:true});
  assert.match(await cancel.getAttribute("title"),/queued jobs.*Active jobs keep running/);
  let release,received;
  const held=new Promise(resolve=>{release=resolve}),seen=new Promise(resolve=>{received=resolve});
  await page.route("**/fleet/queue/cancel",async route=>{
    assert.deepEqual(route.request().postDataJSON(),{batch_id:first.batch_id});
    received();await held;await route.continue();
  },{times:1});
  t.after(()=>release());
  await cancel.click();await confirmCancellation(page);await seen;
  assert.equal(await portrait.getByRole("button",{name:"Cancelling…",exact:true}).isEnabled(),false);
  current=await state();finished=current.jobs.find(j=>j.occupied);
  await post("/fixture",{worker:finished.worker_id,complete:finished.remote_id});
  const before=await until(s=>s.jobs.filter(j=>j.state==="succeeded"&&j.collection_state==="collected").length===2&&s.jobs.filter(j=>j.acknowledged).length===4);
  release();
  await page.getByRole("region",{name:"Notifications",exact:true})
    .getByText('Cancelled 1 queued job in “Portraits”. Active jobs keep running.',{exact:true}).waitFor();
  const after=await state();
  assert.equal(after.jobs.filter(j=>j.batch_id===first.batch_id&&j.state==="cancelled").length,1);
  assert.equal(after.jobs.filter(j=>j.batch_id===first.batch_id&&j.occupied).length,2);
  assert.equal(after.jobs.filter(j=>j.batch_id===second.batch_id&&j.state==="waiting").length,2);
  for(const job of before.jobs.filter(j=>j.occupied||j.state==="succeeded"||j.batch_id===second.batch_id)){
    assert.deepEqual(after.jobs.find(j=>j.id===job.id),job);
  }
  for(const worker of Object.values(await fixture()))assert.deepEqual(worker.cancelled,[]);
  await portrait.waitFor({state:"hidden"});
  assert.equal(await queue.getByRole("listitem").count(),1);
  assert.equal(await queue.getByText("Landscapes",{exact:true}).isVisible(),true);
  assert.equal(await page.locator(".fleet-panel").evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await page.reload();await queue.getByText("Landscapes",{exact:true}).waitFor();
  assert.equal(await queue.getByText("Portraits",{exact:true}).count(),0);
});

test("only the selected batch displays Cancelling while its request is pending",{timeout:45000},async t=>{
  const {page,state,submit,until}=await setup(t,{nodeCount:1});
  const first=await submit("Portraits",3);
  await until(s=>s.jobs.some(job=>job.acknowledged));
  const second=await submit("Portraits",2);
  const queue=page.getByRole("region",{name:"Queued Fleet batches",exact:true});
  const target=queue.locator(`[data-batch-id="${first.batch_id}"]`);
  const other=queue.locator(`[data-batch-id="${second.batch_id}"]`);
  let release,received;
  const held=new Promise(resolve=>{release=resolve}),seen=new Promise(resolve=>{received=resolve});
  await page.route("**/fleet/queue/cancel",async route=>{received();await held;await route.continue()},{times:1});
  t.after(()=>release());
  await target.getByRole("button",{name:"Cancel batch",exact:true}).click();await confirmCancellation(page);await seen;
  await page.evaluate(()=>window.comfyFleet.refresh());
  assert.equal(await queue.getByRole("button",{name:"Cancelling…",exact:true}).count(),1);
  assert.equal(await target.getByRole("button",{name:"Cancelling…",exact:true}).isEnabled(),false);
  assert.equal(await other.getByRole("button",{name:"Cancel batch",exact:true}).isVisible(),true);
  assert.equal(await other.getByRole("button",{name:"Cancel batch",exact:true}).isEnabled(),true,"Other batches must not share the selected batch's pending state");
  assert.equal(await queue.getByRole("button",{name:"Cancel queued jobs",exact:true}).isVisible(),true);
  release();await target.waitFor({state:"hidden"});
  assert.equal(await other.getByRole("button",{name:"Cancel batch",exact:true}).isEnabled(),true);
  assert.equal((await state()).jobs.filter(job=>job.batch_id===second.batch_id&&job.state==="waiting").length,2);
});

for(const toast of ["missing","broken"])test(`temporary feedback works when the host notification interface is ${toast}`,{timeout:45000},async t=>{
  const {page,submit}=await setup(t,{toast});
  await page.clock.install();
  await submit("Portraits",1);
  const notice=page.locator(".fleet-notification");
  await notice.getByText("Accepted 1 job. Work will continue if this browser closes.",{exact:true}).waitFor();
  await page.clock.fastForward(4000);
  const handle=page.getByRole("button",{name:"Reorder Node 2",exact:true});
  await handle.focus();await handle.press("Space");await handle.press("Home");await handle.press("Space");
  await notice.getByText("Node order saved. Active jobs keep running.",{exact:true}).waitFor();
  await page.clock.fastForward(1001);
  assert.equal(await notice.isVisible(),true,"An older timer cannot dismiss a newer notification");
  await page.route("**/fleet/workers/reorder",route=>route.abort("connectionfailed"),{times:1});
  await handle.press("Space");await handle.press("End");await handle.press("Space");
  const error=page.getByText(/^Could not reorder nodes\./);await error.waitFor();
  await page.clock.fastForward(4000);
  assert.equal(await notice.isVisible(),false);
  assert.equal(await error.isVisible(),true);
  assert.deepEqual(await page.evaluate(()=>window.nativeNotifications),[]);
  await submit("Another batch",2);
  await notice.getByRole("button",{name:"Dismiss notification",exact:true}).click();
  assert.equal(await notice.isVisible(),false);
  await page.evaluate(()=>window.comfyFleet.dispose());
  await page.clock.fastForward(6000);
  assert.equal(await page.locator(".fleet-panel").count(),0);
});

test("two batch cancellations finish independently when their responses arrive out of order",{timeout:45000},async t=>{
  const {page,state,submit,until}=await setup(t,{nodeCount:1});
  const first=await submit("Portraits",3);await until(s=>s.jobs.some(j=>j.acknowledged));
  const second=await submit("Landscapes",2);
  const queue=page.getByRole("region",{name:"Queued Fleet batches",exact:true});
  const a=queue.locator(`[data-batch-id="${first.batch_id}"]`);
  const b=queue.locator(`[data-batch-id="${second.batch_id}"]`);
  let release,received;
  const held=new Promise(resolve=>{release=resolve}),seen=new Promise(resolve=>{received=resolve});
  await page.route("**/fleet/queue/cancel",async route=>{received();await held;await route.continue()},{times:1});
  t.after(()=>release());
  await a.getByRole("button",{name:"Cancel batch",exact:true}).click();await confirmCancellation(page);await seen;
  await b.getByRole("button",{name:"Cancel batch",exact:true}).click();await confirmCancellation(page);
  await b.waitFor({state:"hidden"});
  assert.equal(await a.getByRole("button",{name:"Cancelling…",exact:true}).isEnabled(),false);
  assert.equal(await queue.getByRole("button",{name:"Cancel queued jobs",exact:true}).isEnabled(),false);
  assert.equal((await state()).jobs.filter(j=>j.batch_id===first.batch_id&&j.state==="waiting").length,2);
  release();await a.waitFor({state:"hidden"});
  const after=await state();
  assert.equal(after.jobs.filter(j=>j.state==="cancelled").length,4);
  assert.equal(after.jobs.filter(j=>j.occupied&&!j.cancel_requested).length,1);
});

test("batch cancellation can be retried without affecting another batch with the same name",{timeout:45000},async t=>{
  const {page,post,state,submit,until}=await setup(t,{nodeCount:1});
  await page.clock.install();
  const first=await submit("Portraits",3);
  await until(s=>s.jobs.some(j=>j.acknowledged));
  const second=await submit("Portraits",2);
  await page.getByText("Accepted 2 jobs. Work will continue if this browser closes.",{exact:true}).waitFor();
  const queue=page.getByRole("region",{name:"Queued Fleet batches",exact:true});
  const target=queue.locator(`[data-batch-id="${first.batch_id}"]`);
  const cancel=target.getByRole("button",{name:"Cancel batch",exact:true});
  const before=await state();
  // Invalid scopes must never accidentally turn into cancellation of the entire queue.
  for(const data of [{batch_id:null},{batch_id:""},{batchId:first.batch_id},[]]){
    const response=await page.request.post(new URL("/fleet/queue/cancel",page.url()).href,{data});
    assert.equal(response.status(),400);
  }
  assert.deepEqual((await state()).jobs,before.jobs);
  await page.route("**/fleet/queue/cancel",route=>route.abort("connectionfailed"),{times:1});
  await cancel.click();await confirmCancellation(page);
  const error=queue.getByText(/^Could not cancel queued jobs in “Portraits”\./);
  await error.waitFor();await page.clock.fastForward(6000);
  assert.equal(await error.isVisible(),true);
  assert.equal(await cancel.isEnabled(),true);
  assert.deepEqual((await state()).jobs,before.jobs);
  await page.mouse.move(0,0);
  assert.equal(await cancel.evaluate(el=>getComputedStyle(el).color),"rgb(242, 166, 166)");
  await cancel.click();await confirmCancellation(page);
  await page.getByRole("region",{name:"Notifications",exact:true})
    .getByText('Cancelled 2 queued jobs in “Portraits”. Active jobs keep running.',{exact:true}).waitFor();
  assert.equal(await error.count(),0);
  const after=await state();
  assert.deepEqual(after.jobs.filter(j=>j.batch_id===second.batch_id),before.jobs.filter(j=>j.batch_id===second.batch_id));
  assert.deepEqual(await post("/fleet/queue/cancel",{batch_id:first.batch_id}),{cancelled:0},"A stale retry never cancels another batch");
  assert.deepEqual((await state()).jobs,after.jobs);
  await page.clock.fastForward(5001);
  assert.equal(await page.getByRole("region",{name:"Notifications",exact:true}).getByRole("status").count(),0);
});

test("active cancellation is beside Your nodes, targets both nodes, and leaves queued and native work alone",{timeout:45000},async t=>{
  const {page,post,state,fixture,submit,until}=await setup(t);
  const active=page.getByRole("button",{name:"Cancel active jobs",exact:true});
  await active.waitFor();
  assert.equal(await active.isEnabled(),false);
  assert.equal(await page.locator(".fleet-header").getByRole("button").count(),0);
  assert.equal(await page.locator(".fleet-nodes-heading").getByRole("button",{name:"Cancel active jobs",exact:true}).count(),1);
  assert.equal(await page.getByText(/\d+ of \d+ enabled/).count(),0);
  await submit("Portraits",4);
  const before=await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  const assigned=before.jobs.filter(j=>j.occupied),waiting=before.jobs.filter(j=>j.state==="waiting");
  // Include an active job on a disabled node; disabling cannot abandon its work.
  const toggle=page.getByRole("switch",{name:"Node 2",exact:true});
  await toggle.click();await page.waitForFunction(()=>document.querySelector('[role=switch][aria-label="Node 2"]').getAttribute('aria-checked')==='false');
  await post("/fixture",{allow_cancel:false});
  await active.click();await confirmCancellation(page);
  await page.getByText("Cancellation requested for 2 active jobs.",{exact:true}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Stopping…",exact:true}).isEnabled(),false);
  const stopping=await state();
  assert(assigned.every(job=>stopping.jobs.find(j=>j.id===job.id).cancel_requested));
  assert(waiting.every(job=>stopping.jobs.find(j=>j.id===job.id).state==="waiting"));
  assert.equal(stopping.paused,false);
  // Once cancellation is acknowledged, the enabled node can take the next queued job.
  await post("/fixture",{allow_cancel:true});
  const resumed=await until(s=>assigned.every(job=>s.jobs.find(j=>j.id===job.id).state==="cancelled")&&s.jobs.some(j=>waiting.some(w=>w.id===j.id)&&j.acknowledged));
  assert.equal(resumed.jobs.filter(j=>j.state==="waiting").length,1);
  for(const worker of Object.values(await fixture())){
    assert(worker.pending.includes("native-job"));assert.equal(worker.cancelled.length,1);
    assert(assigned.some(job=>job.remote_id===worker.cancelled[0]));
  }
  // The separate queue action preserves the replacement active job.
  const replacement=resumed.jobs.find(j=>j.occupied);
  await page.getByRole("button",{name:"Cancel queued jobs",exact:true}).click();await confirmCancellation(page);
  await page.getByText("Cancelled 1 queued job.",{exact:true}).waitFor();
  assert.equal((await state()).jobs.find(j=>j.id===replacement.id).cancel_requested,0);
  await page.reload();await active.waitFor();assert.equal(await active.isEnabled(),true);
  assert.equal(await page.getByRole("button",{name:"Cancel queued jobs",exact:true}).isEnabled(),false);
  assert.equal(await page.getByRole("button",{name:/^Cancel/}).count(),3);
});

test("a node's red Cancel job button confirms and cancels only its assigned job",{timeout:45000},async t=>{
  const {page,post,state,fixture,submit,until}=await setup(t);
  await submit("Portraits",4);
  const started=await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  const job=started.jobs.find(j=>j.worker_id==="node-1");
  const owner=page.getByRole("region",{name:"Node 1 activity",exact:true});
  const other=page.getByRole("region",{name:"Node 2 activity",exact:true});
  const cancel=owner.getByRole("button",{name:"Cancel job",exact:true});
  await cancel.waitFor();await page.mouse.move(0,0);
  assert.equal(await cancel.evaluate(el=>getComputedStyle(el).color),"rgb(242, 166, 166)");
  const buttonBox=await cancel.boundingBox(),statusBox=await owner.getByText("In progress",{exact:true}).boundingBox();
  assert(buttonBox.x>statusBox.x+statusBox.width,"Cancel sits to the right of the job status");
  assert.equal(await owner.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  const sent=[];
  page.on("request",request=>{if(request.method()==="POST"&&request.url().endsWith("/fleet/jobs/cancel"))sent.push(request.postDataJSON())});
  await cancel.click();
  const dialog=page.getByRole("dialog",{name:'Cancel “Portraits” on Node 1?',exact:true});
  await dialog.getByText(/Only this job will be cancelled\. Other active jobs and queued jobs will continue\./).waitFor();
  await dialog.getByRole("button",{name:"Keep jobs",exact:true}).click();
  assert.deepEqual(sent,[]);
  await cancel.click();await page.keyboard.press("Escape");assert.deepEqual(sent,[]);
  // Disabling a node must not remove its ability to cancel work it already owns.
  await page.getByRole("switch",{name:"Node 1",exact:true}).click();
  await until(s=>!s.workers.find(w=>w.id==="node-1").enabled);
  await post("/fixture",{allow_cancel:false});
  let release,received;
  const held=new Promise(resolve=>{release=resolve}),seen=new Promise(resolve=>{received=resolve});
  await page.route("**/fleet/jobs/cancel",async route=>{received();await held;await route.continue()},{times:1});
  t.after(()=>release());
  await cancel.click();await confirmCancellation(page);await seen;
  await page.evaluate(()=>window.comfyFleet.refresh());
  assert.deepEqual(sent,[{job_ids:[job.id]}]);
  assert.equal(await owner.getByRole("button",{name:"Cancelling…",exact:true}).isEnabled(),false);
  assert.equal(await other.getByRole("button",{name:"Cancel job",exact:true}).isEnabled(),true);
  assert.equal(await other.getByText("In progress",{exact:true}).isVisible(),true);
  release();
  await page.getByRole("region",{name:"Notifications",exact:true})
    .getByText('Cancellation requested for “Portraits” on Node 1.',{exact:true}).waitFor();
  const stopping=await state();
  assert.equal(stopping.jobs.find(j=>j.id===job.id).cancel_requested,1);
  for(const original of started.jobs.filter(j=>j.id!==job.id))assert.deepEqual(stopping.jobs.find(j=>j.id===original.id),original);
  assert.equal(await owner.getByRole("button",{name:"Cancelling…",exact:true}).isEnabled(),false);
  await post("/fixture",{allow_cancel:true});
  await until(s=>s.jobs.find(j=>j.id===job.id).state==="cancelled");
  await owner.waitFor({state:"hidden"});
  const workers=await fixture();
  assert.deepEqual(workers["node-1"].cancelled,[job.remote_id]);
  assert.deepEqual(workers["node-2"].cancelled,[]);
  assert(Object.values(workers).every(worker=>worker.pending.includes("native-job")));
  assert.equal((await state()).jobs.filter(j=>j.state==="waiting").length,2);
});

test("a failed single-job cancellation stays on its own node and can be retried",{timeout:45000},async t=>{
  const {page,post,state,submit,until}=await setup(t);
  await page.clock.install();await submit("Portraits",2);
  const before=await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  const owner=page.getByRole("region",{name:"Node 1 activity",exact:true});
  const other=page.getByRole("region",{name:"Node 2 activity",exact:true});
  const cancel=owner.getByRole("button",{name:"Cancel job",exact:true});
  await page.route("**/fleet/jobs/cancel",route=>route.abort("connectionfailed"),{times:1});
  await cancel.click();await confirmCancellation(page);
  const error=owner.getByRole("alert");await error.waitFor();
  assert.match(await error.innerText(),/^Could not cancel this job\./);
  await page.clock.fastForward(6000);
  assert.equal(await error.isVisible(),true);
  assert.equal(await other.getByRole("alert").count(),0);
  assert.equal(await cancel.isEnabled(),true);
  assert.equal(await other.getByRole("button",{name:"Cancel job",exact:true}).isEnabled(),true);
  assert.deepEqual((await state()).jobs,before.jobs);
  assert.equal(await page.getByRole("region",{name:"Notifications",exact:true}).getByRole("status").count(),0);
  await post("/fixture",{allow_cancel:false});
  await cancel.click();await confirmCancellation(page);
  await page.getByText('Cancellation requested for “Portraits” on Node 1.',{exact:true}).waitFor();
  assert.equal(await error.count(),0);
  assert.equal(await owner.getByRole("button",{name:"Cancelling…",exact:true}).isEnabled(),false);
  assert.equal((await state()).jobs.find(j=>j.worker_id==="node-2").cancel_requested,0);
  await page.clock.fastForward(5001);
  assert.equal(await page.getByText('Cancellation requested for “Portraits” on Node 1.',{exact:true}).count(),0);
});

test("confirming cancellation after a node moves to its next job cannot cancel that replacement",{timeout:45000},async t=>{
  const {page,post,state,submit,until}=await setup(t,{nodeCount:1});
  await submit("Portraits",2);
  const started=await until(s=>s.jobs.some(j=>j.acknowledged));
  const first=started.jobs.find(j=>j.occupied);
  const owner=page.getByRole("region",{name:"Node 1 activity",exact:true});
  const sent=[];
  page.on("request",request=>{if(request.method()==="POST"&&request.url().endsWith("/fleet/jobs/cancel"))sent.push(request.postDataJSON())});
  await owner.getByRole("button",{name:"Cancel job",exact:true}).click();
  await page.getByRole("dialog",{name:'Cancel “Portraits” on Node 1?',exact:true}).waitFor();
  await post("/fixture",{worker:first.worker_id,complete:first.remote_id});
  const next=await until(s=>s.jobs.some(j=>j.id!==first.id&&j.acknowledged));
  const replacement=next.jobs.find(j=>j.occupied);
  await page.evaluate(()=>window.comfyFleet.refresh());
  await confirmCancellation(page);
  await page.getByText("This job is no longer active. No other jobs were cancelled.",{exact:true}).waitFor();
  assert.deepEqual(sent,[]);
  assert.deepEqual((await state()).jobs.find(j=>j.id===replacement.id),replacement);
  assert.equal(await owner.getByRole("button",{name:"Cancel job",exact:true}).isEnabled(),true);
  assert.equal(await owner.getByText("In progress",{exact:true}).isVisible(),true);
});

test("a node's rounded card contains its current workflow and time without job numbers or batch progress",{timeout:45000},async t=>{
  const {page,submit,until}=await setup(t);
  await submit("landscaping",1);
  const state=await until(s=>s.jobs.some(job=>job.acknowledged));
  const assigned=state.jobs.find(job=>job.occupied);
  const owner=page.getByRole("list",{name:"Your nodes",exact:true}).getByRole("listitem")
    .filter({has:page.getByRole("switch",{name:`Node ${assigned.worker_id.slice(-1)}`,exact:true})});
  const idle=page.getByRole("list",{name:"Your nodes",exact:true}).getByRole("listitem")
    .filter({hasNot:page.getByRole("switch",{name:`Node ${assigned.worker_id.slice(-1)}`,exact:true})});
  await owner.getByText("landscaping",{exact:true}).waitFor();
  await owner.getByText("In progress",{exact:true}).waitFor();
  assert.equal(await owner.getByText(/^Added /).count(),1);
  assert.equal(await owner.getByText(/^Job \d+/).count(),0);
  assert.equal(await owner.getByText(/jobs? completed/).count(),0);
  assert.equal(await owner.getByRole("progressbar").count(),0);
  assert.equal(await idle.getByText("landscaping",{exact:true}).count(),0);
  assert.equal(await idle.getByText("Waiting for work",{exact:true}).isVisible(),true);
  const cards=page.getByRole("list",{name:"Your nodes",exact:true}).getByRole("listitem");
  const appearance=await cards.evaluateAll(items=>items.map(item=>{
    const style=getComputedStyle(item),box=item.getBoundingClientRect();
    return {radius:parseFloat(style.borderRadius),background:style.backgroundColor,top:box.top,bottom:box.bottom};
  }));
  assert(appearance.every(card=>card.radius>=10&&card.background!=="rgba(0, 0, 0, 0)"),"Each node has its own rounded background");
  assert(appearance[1].top-appearance[0].bottom>=10,"Space between nodes makes workflow ownership clear");
  await page.reload();await owner.getByText("landscaping",{exact:true}).waitFor();
  if(process.env.FLEET_E2E_SCREENSHOTS){
    await mkdir(process.env.FLEET_E2E_SCREENSHOTS,{recursive:true});
    await page.locator("main").screenshot({path:join(process.env.FLEET_E2E_SCREENSHOTS,"node-cards.png")});
  }
});

test("every active job shows live step progress without fetching or displaying previews",{timeout:45000},async t=>{
  const {page,post,submit,until}=await setup(t);
  const previewRequests=[];
  page.on("request",request=>{if(request.url().includes("/fleet/preview/"))previewRequests.push(request.url())});
  await submit("Portraits",2);
  const current=await until(s=>s.jobs.filter(job=>job.acknowledged).length===2);
  const [first,second]=current.jobs.filter(job=>job.occupied);
  const card=job=>page.locator(`.fleet-job[data-job-id="${job.id}"]`);
  const bar=job=>card(job).getByRole("progressbar",{name:"Current step progress",exact:true});
  const emit=(job,type,data={})=>post("/fixture",{worker:job.worker_id,event:{type,data:{prompt_id:job.remote_id,...data}}});
  const percentage=async(job,value)=>{
    await card(job).getByText(`Current step · ${value}%`,{exact:true}).waitFor();
    assert.equal(await bar(job).getAttribute("value"),String(value));
  };
  await card(first).waitFor();await card(second).waitFor();
  assert.equal(await page.getByRole("progressbar").count(),0,"No fake progress before a worker reports it");
  await emit(first,"preview");
  await emit(first,"executing",{node:"sampler"});
  await emit(first,"progress",{node:"sampler",value:2,max:10});
  await percentage(first,20);
  assert.equal((await page.request.get(new URL(`/fleet/preview/${first.id}`,page.url()).href)).status(),404,
    "Unused image previews must not be retained or served by Fleet");
  assert.equal(await bar(second).count(),0,"Progress belongs only to its assigned job");
  await emit(second,"progress_state",{nodes:{sampler:{state:"running",value:3,max:10}}});
  await percentage(second,30);
  // Updates for every node arrive live, even while periodic state polling is held.
  let release,seen;
  const pending=new Promise(resolve=>{release=resolve}),received=new Promise(resolve=>{seen=resolve});
  t.after(()=>release());
  await page.route("**/fleet/state",async route=>{seen();await pending;await route.continue()},{times:1});
  await received;
  await bar(first).evaluate(el=>{el.dataset.kept="true"});
  const cancel=card(first).getByRole("button",{name:"Cancel job",exact:true});
  await cancel.focus();
  await emit(first,"progress",{node:"sampler",value:8,max:10});
  await percentage(first,80);
  assert.equal(await bar(first).getAttribute("data-kept"),"true","Progress updates keep existing job controls and bars mounted");
  assert.equal(await cancel.evaluate(el=>el===document.activeElement),true);
  await emit(first,"progress",{prompt_id:"native-job",node:"sampler",value:1,max:10});
  await emit(second,"progress_state",{nodes:{sampler:{state:"running",value:6,max:10}}});
  await percentage(second,60);
  await percentage(first,80);
  await emit(first,"preview");
  assert.equal(await page.locator(".fleet-panel img").count(),0);
  assert.deepEqual(previewRequests,[],"Fleet should not download preview images it will not display");
  const refreshed=page.waitForResponse(response=>response.url().endsWith("/fleet/state"));
  release();await refreshed;
  await page.reload();await percentage(first,80);await percentage(second,60);
  if(process.env.FLEET_E2E_SCREENSHOTS){
    await mkdir(process.env.FLEET_E2E_SCREENSHOTS,{recursive:true});
    await page.locator("main").screenshot({path:join(process.env.FLEET_E2E_SCREENSHOTS,"node-step-progress.png")});
  }
  // A completed step must not leave a stuck bar during unmeasurable work.
  await emit(first,"executing",{node:"decode"});
  await bar(first).waitFor({state:"hidden"});
  await emit(second,"progress_state",{nodes:{sampler:{state:"finished",value:10,max:10},decode:{state:"running",value:0,max:1}}});
  await bar(second).waitFor({state:"hidden"});
  await emit(first,"progress",{node:"decode",value:1,max:0});
  assert.equal(await bar(first).count(),0);
  await emit(first,"progress",{node:"decode",value:5,max:20});await percentage(first,25);
  await emit(first,"execution_success");await bar(first).waitFor({state:"hidden"});
  await post("/fixture",{worker:first.worker_id,complete:first.remote_id});
  await until(s=>s.jobs.some(job=>job.id===first.id&&job.state==="succeeded"));
  await card(first).waitFor({state:"hidden"});
  const next=await submit("Landscapes",1);
  const replaced=await until(s=>s.jobs.some(job=>job.batch_id===next.batch_id&&job.acknowledged));
  const replacement=replaced.jobs.find(job=>job.batch_id===next.batch_id);
  await card(replacement).getByText("Landscapes",{exact:true}).waitFor();
  assert.equal(await bar(replacement).count(),0,"A new job must not inherit its predecessor's progress");
  assert.equal(await page.locator(".fleet-panel img").count(),0);
  assert.deepEqual(previewRequests,[]);
});

for(const [disabledDuringAdmission,count] of [[false,16],[true,3],[true,16]]) test(`re-enabling an idle node takes the first queued batch after reordering (disabled during admission: ${disabledDuringAdmission}, batch size: ${count})`,{timeout:45000},async t=>{
  const {page,post,state,submit,until}=await setup(t);
  const landscaping=await submit("Landscaping",count);
  let home;
  if(!disabledDuringAdmission) home=await submit("Home staging",16);
  const started=await until(s=>s.jobs.filter(job=>job.acknowledged).length===2);
  const original=started.jobs.find(job=>job.worker_id==="node-1"&&job.occupied);
  assert.equal(original.batch_id,landscaping.batch_id);
  const toggle=page.getByRole("switch",{name:"Node 1",exact:true});
  await toggle.click();await until(s=>!s.workers.find(worker=>worker.id==="node-1").enabled);
  if(disabledDuringAdmission) home=await submit("Home staging",count===3?1:count);
  await post("/fixture",{worker:original.worker_id,complete:original.remote_id});
  await until(s=>s.jobs.some(job=>job.id===original.id&&job.state==="succeeded")&&!s.jobs.some(job=>job.worker_id==="node-1"&&job.occupied));
  const queue=page.getByRole("region",{name:"Queued Fleet batches",exact:true});
  const handle=queue.getByRole("button",{name:"Reorder Home staging",exact:true});
  await handle.scrollIntoViewIfNeeded();
  const from=await handle.boundingBox();
  const target=await queue.getByRole("listitem").filter({hasText:"Landscaping"}).boundingBox();
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();
  await page.mouse.move(from.x+from.width/2,target.y+4,{steps:10});
  const saved=page.waitForResponse(response=>response.url().endsWith("/fleet/queue/reorder"));
  await page.mouse.up();assert.equal((await saved).ok(),true);
  assert.equal((await state()).jobs.find(job=>job.state==="waiting").batch_id,home.batch_id);
  await toggle.click();
  const resumed=await until(s=>s.jobs.some(job=>job.worker_id==="node-1"&&job.occupied&&job.acknowledged));
  assert.equal(resumed.jobs.find(job=>job.worker_id==="node-1"&&job.occupied).batch_id,home.batch_id,
    "A re-enabled node must pick Home staging from the front, not return to Landscaping");
});

test("dragging nodes saves dispatch priority: the first free enabled node gets the next job",{timeout:45000},async t=>{
  const {page,post,state,submit,until}=await setup(t);
  const nodes=page.getByRole("list",{name:"Your nodes",exact:true});
  const dragBefore=async(source,target)=>{
    const handle=nodes.getByRole("button",{name:`Reorder ${source}`,exact:true});
    await handle.scrollIntoViewIfNeeded();
    const start=await handle.boundingBox();
    const end=await nodes.getByRole("listitem").filter({has:page.getByRole("switch",{name:target,exact:true})}).boundingBox();
    await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();
    await page.mouse.move(start.x+start.width/2,end.y+4,{steps:10});
    await page.waitForResponse(response=>response.url().endsWith("/fleet/state"));
    assert.equal(await nodes.locator('[data-dragging="true"]').count(),1,"Live polling keeps the dragged card attached");
    await page.mouse.up();await page.getByText("Node order saved. Active jobs keep running.",{exact:true}).last().waitFor();
  };
  await dragBefore("Node 2","Node 1");
  assert.deepEqual((await state()).workers.map(w=>w.id),["node-2","node-1"]);
  await page.reload();await nodes.getByRole("button",{name:"Reorder Node 2",exact:true}).waitFor();
  assert.equal(await nodes.getByRole("listitem").first().getByRole("switch").getAttribute("aria-label"),"Node 2");
  await submit("Priority first",1);
  let current=await until(s=>s.jobs.some(j=>j.acknowledged));
  const first=current.jobs[0];assert.equal(first.worker_id,"node-2");
  await submit("Use the next free node",1);
  current=await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  const second=current.jobs.find(j=>j.id!==first.id);assert.equal(second.worker_id,"node-1");
  // Wait for the queue row to disappear before measuring the cards' drag positions.
  await page.getByText("No batches waiting",{exact:true}).waitFor();
  await dragBefore("Node 1","Node 2");
  assert.deepEqual((await state()).jobs.map(j=>[j.id,j.worker_id]),current.jobs.map(j=>[j.id,j.worker_id]));
  for(const job of [first,second]) await post("/fixture",{worker:job.worker_id,complete:job.remote_id});
  await until(s=>s.jobs.every(j=>j.state==="succeeded"));
  const thirdBatch=await submit("New priority",1);
  current=await until(s=>s.jobs.some(j=>j.batch_id===thirdBatch.batch_id&&j.acknowledged));
  const third=current.jobs.find(j=>j.batch_id===thirdBatch.batch_id);assert.equal(third.worker_id,"node-1");
  await page.getByRole("switch",{name:"Node 1",exact:true}).click();
  await until(s=>!s.workers.find(w=>w.id==="node-1").enabled);
  await post("/fixture",{worker:third.worker_id,complete:third.remote_id});
  await until(s=>s.jobs.every(j=>j.state==="succeeded"));
  const fourthBatch=await submit("Skip disabled priority",1);
  current=await until(s=>s.jobs.some(j=>j.batch_id===fourthBatch.batch_id&&j.acknowledged));
  assert.equal(current.jobs.find(j=>j.batch_id===fourthBatch.batch_id).worker_id,"node-2");
});

test("keyboard node moves can be cancelled, recover from network failure, and preserve settings during a delayed save",{timeout:45000},async t=>{
  const {page,post,state,submit,until}=await setup(t);
  await submit("Keep running",1);
  const initial=await until(s=>s.jobs.some(j=>j.acknowledged));
  const nodes=page.getByRole("list",{name:"Your nodes",exact:true});
  const handle=nodes.getByRole("button",{name:"Reorder Node 1",exact:true});
  const first=()=>nodes.getByRole("listitem").first().getByRole("switch").getAttribute("aria-label");
  await handle.focus();await handle.press("Space");await handle.press("End");
  assert.equal(await first(),"Node 2");
  await handle.press("Escape");assert.equal(await first(),"Node 1");
  assert.deepEqual((await state()).workers,initial.workers);
  await page.route("**/fleet/workers/reorder",route=>route.abort("connectionfailed"),{times:1});
  await handle.press("Enter");await handle.press("End");await handle.press("Enter");
  await page.getByText(/^Could not reorder nodes\./).waitFor();
  assert.equal(await first(),"Node 1");assert.deepEqual((await state()).workers,initial.workers);
  let release,received;
  const held=new Promise(resolve=>{release=resolve}),seen=new Promise(resolve=>{received=resolve});
  await page.route("**/fleet/workers/reorder",async route=>{received();await held;await route.continue()},{times:1});
  t.after(()=>release());
  await handle.press("Space");await handle.press("End");await handle.press("Space");await seen;
  assert.equal(await handle.isEnabled(),false);
  assert.equal(await nodes.getByRole("switch",{name:"Node 2",exact:true}).isEnabled(),false);
  assert.equal(await page.getByRole("button",{name:"Manage nodes",exact:true}).isEnabled(),false);
  assert.equal(await page.getByRole("button",{name:"Cancel active jobs",exact:true}).isEnabled(),false);
  await post("/fleet/workers",{workers:initial.workers.map(w=>({id:w.id,url:w.url,enabled:w.id!=="node-2"}))});
  await page.waitForResponse(response=>response.url().endsWith("/fleet/state"));
  assert.equal(await first(),"Node 2","Polling cannot undo a pending move");
  release();await page.getByText("Node order saved. Active jobs keep running.",{exact:true}).waitFor();
  const saved=await state();
  assert.deepEqual(saved.workers.map(w=>w.id),["node-2","node-1"]);
  assert.equal(Boolean(saved.workers[0].enabled),false,"An order change must preserve a concurrent enable/disable change");
  assert.deepEqual(saved.jobs,initial.jobs);
  assert.equal(await handle.evaluate(el=>el===document.activeElement),true);
  await page.reload();await handle.waitFor();assert.equal(await first(),"Node 2");
});

test("a long node list scrolls while dragging and a stale drop restores the current server list",{timeout:45000},async t=>{
  const {page,post,state}=await setup(t,{nodeCount:12});
  const nodes=page.getByRole("list",{name:"Your nodes",exact:true});
  const handle=nodes.getByRole("button",{name:"Reorder Node 12",exact:true});
  await handle.scrollIntoViewIfNeeded();
  const start=await handle.boundingBox(),panel=await page.locator(".fleet-panel").boundingBox();
  assert.equal(await handle.evaluate(el=>getComputedStyle(el).cursor),"grab");
  await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();
  await page.mouse.move(start.x+start.width/2,panel.y+3,{steps:10});
  await page.waitForFunction(()=>document.querySelector('.fleet-panel').scrollTop===0);
  assert.equal(await nodes.locator('[data-drop="before"]').getAttribute("data-worker-id"),"node-1");
  await page.mouse.up();await page.getByText("Node order saved. Active jobs keep running.",{exact:true}).waitFor();
  assert.equal((await state()).workers[0].id,"node-12");
  await page.reload();await handle.waitFor();
  assert.equal(await nodes.getByRole("listitem").first().getByRole("switch").getAttribute("aria-label"),"Node 12");
  // Another browser removes the target while this one has a card picked up.
  await handle.focus();await handle.press("Space");await handle.press("End");
  const existing=await state();
  await post("/fleet/workers",{workers:existing.workers.filter(w=>w.id!=="node-11").map(w=>({id:w.id,url:w.url,enabled:Boolean(w.enabled)}))});
  // Move before the old last node, which no longer exists on the server.
  await handle.press("ArrowUp");await handle.press("Space");
  await page.getByText("Could not reorder nodes. The node list changed. Try reordering again.",{exact:true}).waitFor();
  assert.equal(await nodes.getByRole("listitem").count(),11);
  assert.equal(await nodes.getByRole("listitem").first().getByRole("switch").getAttribute("aria-label"),"Node 12");
});

test("node cards retain their batch identity after it leaves Queue and update when a new workflow starts",{timeout:45000},async t=>{
  const {page,post,submit,until}=await setup(t);
  const first=await submit("Portraits",4);
  const started=await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  const original=started.jobs.filter(j=>j.occupied);
  const second=await submit("Landscapes",3);
  const queue=page.getByRole("region",{name:"Queued Fleet batches",exact:true});
  const node=id=>page.getByRole("region",{name:`Node ${id.slice(-1)} activity`,exact:true});
  for(const job of original){
    await node(job.worker_id).getByText("Portraits",{exact:true}).waitFor();
    assert.equal(await node(job.worker_id).getByText(/^Added /).count(),1);
    assert.equal(await node(job.worker_id).getByRole("progressbar").count(),0);
  }
  await post("/fixture",{worker:original[0].worker_id,complete:original[0].remote_id});
  let current=await until(s=>s.jobs.filter(j=>j.batch_id===first.batch_id&&j.state==="succeeded").length===1&&s.jobs.some(j=>j.ordinal===2&&j.acknowledged));
  await queue.getByText("1 of 4 jobs completed",{exact:true}).waitFor();
  assert.equal(await queue.getByRole("progressbar",{name:"Portraits completed jobs",exact:true}).getAttribute("value"),"1");
  assert.equal(await node(original[1].worker_id).getByText("Portraits",{exact:true}).isVisible(),true);
  const third=current.jobs.find(j=>j.batch_id===first.batch_id&&j.ordinal===2);
  await post("/fixture",{worker:third.worker_id,complete:third.remote_id});
  current=await until(s=>s.jobs.filter(j=>j.batch_id===first.batch_id&&j.state==="succeeded").length===2&&s.jobs.some(j=>j.batch_id===first.batch_id&&j.ordinal===3&&j.acknowledged));
  assert.equal(current.batch_names[first.batch_id],"Portraits","Active-only batches retain their saved workflow name");
  await queue.getByText("Portraits",{exact:true}).waitFor({state:"hidden"});
  assert.equal(await node(original[1].worker_id).getByText("Portraits",{exact:true}).isVisible(),true);
  await post("/fixture",{worker:original[1].worker_id,complete:original[1].remote_id});
  current=await until(s=>s.jobs.some(j=>j.batch_id===second.batch_id&&j.acknowledged));
  const last=current.jobs.find(j=>j.batch_id===first.batch_id&&j.occupied);
  const next=current.jobs.find(j=>j.batch_id===second.batch_id&&j.occupied);
  await node(last.worker_id).getByText("Portraits",{exact:true}).waitFor();
  await node(next.worker_id).getByText("Landscapes",{exact:true}).waitFor();
  assert.equal(await node(last.worker_id).getByRole("progressbar").count(),0);
  assert.equal(await node(next.worker_id).getByRole("progressbar").count(),0);
  assert.equal(await node(last.worker_id).getByText(/^Job \d+/).count(),0);
  await page.reload();await node(last.worker_id).getByText("Portraits",{exact:true}).waitFor();
  assert.equal(await node(last.worker_id).getByText("In progress",{exact:true}).isVisible(),true);
  assert.equal(await node(next.worker_id).getByText("Landscapes",{exact:true}).isVisible(),true);
  assert.equal(await page.locator(".fleet-panel").evaluate(el=>el.scrollWidth<=el.clientWidth),true,"A 320px sidebar must not scroll horizontally");
  if(process.env.FLEET_E2E_SCREENSHOTS){
    await mkdir(process.env.FLEET_E2E_SCREENSHOTS,{recursive:true});
    await page.locator("main").screenshot({path:join(process.env.FLEET_E2E_SCREENSHOTS,"node-batches.png")});
  }
  // Finish the older batch: its node refills with the next workflow, with no stale title.
  await post("/fixture",{worker:last.worker_id,complete:last.remote_id});
  await until(s=>s.jobs.filter(j=>j.batch_id===second.batch_id&&j.acknowledged).length===2);
  await node(last.worker_id).getByText("Landscapes",{exact:true}).waitFor();
  await node(last.worker_id).getByText("Portraits",{exact:true}).waitFor({state:"hidden"});
  assert.equal(await node(last.worker_id).getByText("In progress",{exact:true}).isVisible(),true);
});

test("failed active cancellation can be retried, blocks repeat clicks while saving, and becomes idle after acknowledgement",{timeout:45000},async t=>{
  const {page,post,state,submit,until}=await setup(t);
  await submit("Single job",1);
  const before=await until(s=>s.jobs.some(j=>j.acknowledged));
  const active=page.getByRole("button",{name:"Cancel active jobs",exact:true});
  // Drop only this outgoing request at the browser's network boundary.
  await page.route("**/fleet/jobs/cancel-active",route=>route.abort("connectionfailed"),{times:1});
  await active.click();await confirmCancellation(page);await page.getByText(/^Could not cancel active jobs\./).waitFor();
  assert.deepEqual((await state()).jobs,before.jobs);
  assert.equal(await active.isEnabled(),true);
  assert.equal(await page.getByRole("button",{name:"Cancel queued jobs",exact:true}).isEnabled(),false);
  await post("/fixture",{allow_cancel:false});
  let release,received;
  const held=new Promise(resolve=>{release=resolve}),seen=new Promise(resolve=>{received=resolve});
  await page.route("**/fleet/jobs/cancel-active",async route=>{received();await held;await route.continue()},{times:1});
  t.after(()=>release());
  await active.click();await confirmCancellation(page);await seen;
  const stopping=page.getByRole("button",{name:"Stopping…",exact:true});
  assert.equal(await stopping.isEnabled(),false);
  await page.waitForResponse(response=>response.url().endsWith("/fleet/state"));
  assert.equal(await stopping.isEnabled(),false,"Polling must not re-enable an in-flight action");
  assert.equal((await state()).jobs[0].cancel_requested,0);
  release();await page.getByText("Cancellation requested for 1 active job.",{exact:true}).waitFor();
  assert.equal(await page.getByText(/^Could not cancel active jobs\./).count(),0);
  await page.getByText("Cancelling",{exact:true}).waitFor();
  assert.equal(await stopping.isEnabled(),false);
  await post("/fixture",{allow_cancel:true});
  await until(s=>s.jobs[0].state==="cancelled");
  await active.waitFor();assert.equal(await active.isEnabled(),false);
  assert.equal(await page.getByRole("progressbar").count(),0);
  assert.equal(await page.getByText("Waiting for work",{exact:true}).count(),2);
  await page.getByRole("button",{name:"Manage nodes",exact:true}).click();
  assert.equal(await active.isVisible(),false,"Dashboard actions must not appear in node setup");
});

test("node backup controls report a configuration-only JSON export", {timeout:30000}, async t => {
  const {page}=await setup(t);
  await page.getByText('Backup & recovery',{exact:true}).click();
  const button=page.getByRole('button',{name:'Back up nodes',exact:true});
  assert.equal(await button.count(),1);
  const saved=page.waitForResponse(response=>response.url().endsWith('/fleet/backup')&&response.request().method()==='POST');
  await button.click();
  const response=await saved;
  assert.equal(response.ok(),true,await response.text());
  const result=await response.json();
  assert.equal(result.nodes,2);
  assert(result.filename.endsWith('.json'));
  await page.locator('.fleet-backup-feedback').getByText(`fleet/backups/${result.filename}`,{exact:true}).waitFor();
});

test("native clear queue preserves a job assigned since the browser snapshot", {timeout:30000}, async t => {
  const {page,post,submit,until,state}=await setup(t,{nodeCount:1});
  await page.clock.install({time:new Date('2026-10-01T10:00:00Z')});
  await page.clock.pauseAt(new Date('2026-10-01T10:00:00Z'));
  await submit("landscaping",2);
  const current=await until(s=>s.jobs.some(j=>j.acknowledged));
  await page.evaluate(()=>window.comfyFleet.refresh());
  const first=current.jobs.find(j=>j.occupied), second=current.jobs.find(j=>j.state==='waiting');
  await post('/fixture',{worker:first.worker_id,complete:first.remote_id});
  await until(s=>s.jobs.some(j=>j.id===second.id&&j.acknowledged));
  assert.equal(await page.evaluate(id=>window.comfyFleet.snapshot().server.jobs.find(j=>j.id===id).state,second.id),'waiting');
  await page.evaluate(async()=>{
    const {api}=await import('/scripts/api.js');
    await api.fetchApi('/queue',{method:'POST',body:JSON.stringify({clear:true})});
  });
  assert.equal((await state()).jobs.find(j=>j.id===second.id).cancel_requested,0,"Clear queue must preserve newly assigned work");
});


test("native queue deletion preserves jobs that have started since the browser snapshot", {timeout:30000}, async t => {
  const {page,post,submit,until,state}=await setup(t,{nodeCount:1});
  await page.clock.install({time:new Date('2026-10-01T10:00:00Z')});
  await page.clock.pauseAt(new Date('2026-10-01T10:00:00Z'));
  await submit("landscaping",3);
  const current=await until(s=>s.jobs.some(job=>job.acknowledged));
  await page.evaluate(()=>window.comfyFleet.refresh());
  const first=current.jobs.find(job=>job.occupied);
  const [second,third]=current.jobs.filter(job=>job.state==='waiting');
  await post('/fixture',{worker:first.worker_id,complete:first.remote_id});
  await until(s=>s.jobs.some(job=>job.id===second.id&&job.acknowledged));
  await page.evaluate(async ids=>{
    const {api}=await import('/scripts/api.js');
    await api.fetchApi('/queue',{method:'POST',body:JSON.stringify({delete:ids})});
  },[second.id,third.id]);
  const after=await state();
  assert.equal(after.jobs.find(job=>job.id===second.id).cancel_requested,0);
  assert.equal(after.jobs.find(job=>job.id===third.id).state,'cancelled');
});

for (const action of ['save','discard']) test(`setup ${action} releases detached node cards`, {timeout:30000}, async t => {
  const {page}=await setup(t);
  await page.getByRole('button',{name:'Manage nodes',exact:true}).click();
  await page.evaluate(()=>{
    window.previousSetupCards=[...document.querySelectorAll('.fleet-node-card')].map(card=>new WeakRef(card));
  });
  if (action==='discard') {
    await page.getByRole('textbox',{name:'Name (optional)',exact:true}).fill('unfinished');
    await page.getByRole('button',{name:'Discard changes',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Discard changes',exact:true}).click();
  } else {
    await page.getByRole('button',{name:'Done',exact:true}).click();
  }
  await page.getByRole('button',{name:'Manage nodes',exact:true}).waitFor();
  const heap=await page.context().newCDPSession(page);
  let retained;
  for (let attempt=0; attempt<3; attempt++) {
    await heap.send('HeapProfiler.collectGarbage');
    retained=await page.evaluate(()=>window.previousSetupCards.filter(ref=>ref.deref()).length);
    if (!retained) break;
  }
  assert.equal(retained,0,
    'Leaving setup must release its detached DOM, including node details and event closures');
  await heap.detach();
});

test("native clear queue supports more than 1000 waiting jobs across batches", {timeout:60000}, async t => {
  const {page,submit,until,state}=await setup(t,{nodeCount:1});
  await submit("landscaping",1000);
  await until(s=>s.jobs.some(j=>j.acknowledged));
  await submit("landscaping",3);
  await page.evaluate(()=>window.comfyFleet.refresh());
  const before=await state();
  assert.equal(before.jobs.filter(j=>j.state==='waiting').length,1002);
  const result=await page.evaluate(async()=>{
    const {api}=await import('/scripts/api.js');
    try {return {status:(await api.fetchApi('/queue',{method:'POST',body:JSON.stringify({clear:true})})).status}}
    catch(error){return {error:error.message}}
  });
  assert.deepEqual(result,{status:200});
  assert.equal((await state()).jobs.filter(j=>j.state==='waiting').length,0);
});

test("clearing history removes completed activity from hidden node cards", {timeout:30000}, async t => {
  const {page,post,submit,until}=await setup(t,{nodeCount:1});
  await submit("landscaping demo",1);
  const current=await until(s=>s.jobs.some(j=>j.acknowledged));
  const row=current.jobs.find(j=>j.occupied);
  await page.locator('.fleet-worker-details').getByText('landscaping demo',{exact:true}).waitFor();
  await post('/fixture',{worker:row.worker_id,complete:row.remote_id});
  await until(s=>s.jobs.some(j=>j.id===row.id&&j.collection_state==='collected'));
  await page.evaluate(async()=>{
    await window.comfyFleet.refresh();
    const {api}=await import('/scripts/api.js');
    await api.fetchApi('/history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clear:true})});
  });
  const text=await page.locator('.fleet-worker-details').textContent();
  assert.equal(text,'',"Finished activity must be released, not only hidden");
});

async function openBatchEditor(page, id, label="Edit workflow") {
  await page.evaluate(()=>window.comfyFleet.refresh());
  const row=page.locator(`[data-batch-id="${id}"]`);
  await row.locator("summary").click();
  await row.getByRole("button",{name:label,exact:true}).click();
  await page.getByRole("button",{name:"Save to batch",exact:true}).waitFor();
}

test("editing restores authored source, autosaves across reload, and atomically replaces remaining jobs",{timeout:45000},async t=>{
  const {page,submit,state,until,post}=await setup(t);
  await page.evaluate(async()=>{
    const {app}=await import('/scripts/app.js');
    app.rootGraph.extra.prompt="{a|b}";
    app.rootGraph.nodes=[{widgets:[{beforeQueued(){app.rootGraph.extra.prompt="a"}}]}];
  });
  const accepted=await submit("Production",6);
  await until(s=>s.jobs.filter(job=>job.acknowledged).length===2);
  const original=await state();
  await openBatchEditor(page,accepted.batch_id);
  assert.equal(await page.evaluate(async()=>(await import('/scripts/app.js')).app.rootGraph.extra.prompt),"{a|b}");
  assert.equal((await state()).edit.batch_id,accepted.batch_id);
  assert.equal(await page.evaluate(async()=>(await import('/scripts/app.js')).app.queuePrompt(0,1)),false);
  assert.equal((await state()).jobs.length,6);
  const autosaved=page.waitForResponse(r=>r.url().endsWith('/fleet/edit/draft') && r.request().postDataJSON().source.extra.prompt==="{c|d}");
  await page.evaluate(async()=>{(await import('/scripts/app.js')).app.rootGraph.extra.prompt="{c|d}"});
  assert((await autosaved).ok());
  await post('/fixture',{restart:true});
  await page.reload();
  await page.getByRole("button",{name:"Manage nodes",exact:true}).waitFor();
  await openBatchEditor(page,accepted.batch_id,"Resume editing");
  assert.equal(await page.evaluate(async()=>(await import('/scripts/app.js')).app.rootGraph.extra.prompt),"{c|d}");
  const saved=page.waitForResponse(r=>r.url().endsWith('/fleet/edit/save'));
  await page.getByRole('button',{name:'Save to batch',exact:true}).click();
  const response=await saved;assert.equal(response.ok(),true,await response.text());
  await until(s=>!s.edit);
  const ids=(await response.json()).job_ids;
  assert.equal(ids.length,4);
  const after=await state();
  assert.deepEqual(after.jobs.map(j=>j.id),original.jobs.map(j=>j.id));
  for(const id of ids){
    const detail=await (await page.request.get(new URL(`/fleet/jobs/${id}`,page.url()).href)).json();
    assert.equal(detail.workflow?.extra_data?.extra_pnginfo?.workflow?.extra?.prompt,"{c|d}");
  }
});

test("later edit holds assignment at its position, locks reorder, and discard releases original work",{timeout:45000},async t=>{
  const {page,submit,state,until,post,fixture}=await setup(t,{nodeCount:1});
  const first=await submit("First",2), second=await submit("Second",2), third=await submit("Third",1);
  await until(s=>s.jobs.some(j=>j.acknowledged));
  await openBatchEditor(page,second.batch_id);
  const reordered=await page.request.post(new URL('/fleet/queue/reorder',page.url()).href,{data:{batch_id:third.batch_id,before_batch_id:first.batch_id}});
  assert.equal(reordered.status(),409);
  for(let index=0;index<2;index++){
    const current=await until(s=>s.jobs.some(j=>j.batch_id===first.batch_id&&j.acknowledged&&j.occupied));
    const job=current.jobs.find(j=>j.batch_id===first.batch_id&&j.occupied);
    await post('/fixture',{worker:job.worker_id,complete:job.remote_id});
    await until(s=>!s.jobs.some(j=>j.id===job.id&&j.occupied));
  }
  await page.waitForTimeout(800);
  assert(!(await state()).jobs.some(j=>j.occupied));
  assert.equal(Object.values(await fixture()).flatMap(w=>w.pending).filter(id=>id!=="native-job").length,0);
  await page.getByRole('button',{name:'Discard changes',exact:true}).click();
  const resumed=await until(s=>s.jobs.some(j=>j.batch_id===second.batch_id&&j.occupied));
  assert.equal(resumed.edit,null);
});

test("retrying an unconfirmed batch save reuses the prepared request without rerunning widget hooks",{timeout:45000},async t=>{
  const {page,submit,until}=await setup(t);
  const accepted=await submit("Retry",5);
  await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  await openBatchEditor(page,accepted.batch_id);
  await page.evaluate(async()=>{
    const {app}=await import('/scripts/app.js');
    const original=app.graphToPrompt;
    window.preparations=0;
    app.graphToPrompt=async(...args)=>{window.preparations++;return original.apply(app,args)};
  });
  const requests=[];
  await page.route('**/fleet/edit/save',async route=>{
    requests.push(route.request().postData());
    if(requests.length===1)await route.abort('failed');else await route.continue();
  });
  await page.getByRole('button',{name:'Save to batch',exact:true}).click();
  await page.getByRole('button',{name:'Retry save',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.preparations),3);
  assert.equal(await page.evaluate(async()=>{
    const {app}=await import('/scripts/app.js');
    return app.extensionManager.workflow.openWorkflows.length===2 && Boolean(app.rootGraph.extra.fleet_edit_id);
  }),true,"An unconfirmed save must keep the editing tab open");
  await page.getByRole('button',{name:'Retry save',exact:true}).click();
  await until(s=>!s.edit);
  assert.equal(requests.length,2);
  assert.equal(requests[0],requests[1]);
  assert.equal(await page.evaluate(()=>window.preparations),3);
});

test("an abandoned edit can be discarded from the queue without loading its workflow",{timeout:45000},async t=>{
  const {page,submit,until,state}=await setup(t);
  const accepted=await submit("Abandoned",5);
  await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  await openBatchEditor(page,accepted.batch_id);
  await page.reload();
  await page.getByRole('button',{name:'Manage nodes',exact:true}).waitFor();
  const row=page.locator(`[data-batch-id="${accepted.batch_id}"]`);
  await row.locator('summary').click();
  await row.getByRole('button',{name:'Discard changes and resume',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Discard changes',exact:true}).click();
  await until(s=>!s.edit);
  assert.equal((await state()).jobs.length,5);
  assert.equal(await page.locator('.fleet-edit-bar:visible').count(),0);
});

test("discarding an inactive edit closes only its tab without switching the current workflow",{timeout:30000},async t=>{
  const {page,submit,until}=await setup(t);
  const accepted=await submit('Production',5);
  await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  await openBatchEditor(page,accepted.batch_id);
  await page.evaluate(async()=>{
    const {app}=await import('/scripts/app.js');
    window.testApp=app;
    await app.loadGraphData({nodes:[],extra:{unsaved:'Current work'}},true,true,'Another workflow');
  });
  const row=page.locator(`[data-batch-id="${accepted.batch_id}"]`);
  await row.locator('summary').click();
  await row.getByRole('button',{name:'Discard changes and resume',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Discard changes',exact:true}).click();
  await until(s=>!s.edit);
  await page.waitForFunction(()=>window.testApp.extensionManager.workflow.openWorkflows.length===2);
  assert.deepEqual(await page.evaluate(()=>({
    names:window.testApp.extensionManager.workflow.openWorkflows.map(w=>w.filename),
    active:window.testApp.extensionManager.workflow.activeWorkflow.filename,
    extra:window.testApp.rootGraph.extra,
  })),{names:['Production.json','Another workflow'],active:'Another workflow',extra:{unsaved:'Current work'}});
});

test("discarding the last open edit tab returns to a blank workflow",{timeout:30000},async t=>{
  const {page,submit,until}=await setup(t);
  const accepted=await submit('Production',5);
  await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  await openBatchEditor(page,accepted.batch_id);
  await page.evaluate(async()=>{
    const {app}=await import('/scripts/app.js');
    window.testApp=app;
    const workflows=app.extensionManager.workflow;
    await workflows.closeWorkflow(workflows.openWorkflows[0]);
  });
  await page.getByRole('button',{name:'Discard changes',exact:true}).click();
  await until(s=>!s.edit);
  await page.waitForFunction(()=>!window.testApp.rootGraph.extra.fleet_edit_id);
  assert.deepEqual(await page.evaluate(()=>({
    names:window.testApp.extensionManager.workflow.openWorkflows.map(w=>w.filename),
    graph:window.testApp.rootGraph.serialize(),
  })),{names:['Unsaved Workflow.json'],graph:{nodes:[],extra:{}}});
});

test("a heartbeat after commit cannot invalidate a save whose response is still arriving",{timeout:30000},async t=>{
  const {page,submit,until}=await setup(t);
  const accepted=await submit("Slow response",5);
  await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  await openBatchEditor(page,accepted.batch_id);
  let deliver;
  const delivery=new Promise(resolve=>{deliver=resolve});
  t.after(()=>deliver());
  await page.route('**/fleet/edit/save',async route=>{
    const response=await route.fetch();
    await delivery;
    await route.fulfill({response});
  });
  const heartbeat=page.waitForResponse(r=>r.url().endsWith('/fleet/edit/touch')&&r.status()===409);
  await page.getByRole('button',{name:'Save to batch',exact:true}).click();
  await heartbeat;
  deliver();
  await page.getByText('Updated the remaining jobs in this batch.',{exact:true}).waitFor();
  assert.equal(await page.locator('.fleet-edit-bar:visible').count(),0);
  await until(s=>!s.edit);
});

for (const action of ['Save to batch','Discard changes']) test(`${action} closes the edit tab and restores the previous unsaved workflow`,{timeout:30000},async t=>{
  const {page,submit,until}=await setup(t);
  const accepted=await submit('Production',5);
  await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  const before=await page.evaluate(async()=>{
    const {app}=await import('/scripts/app.js');
    window.testApp=app;
    app.rootGraph.extra.unsaved='Keep my other workflow changes';
    return {name:app.extensionManager.workflow.activeWorkflow.filename,graph:app.rootGraph.serialize()};
  });
  await openBatchEditor(page,accepted.batch_id);
  await page.evaluate(async()=>{(await import('/scripts/app.js')).app.rootGraph.extra.prompt='Edited draft'});
  assert.equal(await page.evaluate(async()=>(await import('/scripts/app.js')).app.extensionManager.workflow.openWorkflows.length),2);
  await page.getByRole('button',{name:action,exact:true}).click();
  await until(s=>!s.edit);
  await page.waitForFunction(()=>window.testApp.extensionManager.workflow.openWorkflows.length===1);
  const after=await page.evaluate(async()=>{
    const {app}=await import('/scripts/app.js');
    return {name:app.extensionManager.workflow.activeWorkflow.filename,graph:app.rootGraph.serialize()};
  });
  assert.deepEqual(after,before);
  assert.equal(await page.locator('.fleet-edit-bar:visible').count(),0);
});

async function openBatchRename(page, id) {
  await page.evaluate(()=>window.comfyFleet.refresh());
  const row=page.locator(`[data-batch-id="${id}"]`);
  await row.locator('summary').click();
  await row.getByRole('button',{name:'Rename batch',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Rename batch',exact:true});
  await dialog.waitFor();
  return dialog;
}

test('renaming a queued batch persists, updates active cards, and preserves its jobs and position',{timeout:30000},async t=>{
  const {page,submit,until,state,post}=await setup(t);
  const first=await submit('Original',5);
  const second=await submit('Other batch',2);
  await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  const before=await state();
  const dialog=await openBatchRename(page,first.batch_id);
  const input=dialog.getByRole('textbox',{name:'Batch name',exact:true});
  assert.equal(await input.inputValue(),'Original');
  assert.equal(await input.evaluate(el=>el===document.activeElement),true);
  const renamed='Finals — <v2>';
  await input.fill(`  ${renamed}  `);
  if(process.env.FLEET_E2E_SCREENSHOTS){
    await mkdir(process.env.FLEET_E2E_SCREENSHOTS,{recursive:true});
    await page.screenshot({path:join(process.env.FLEET_E2E_SCREENSHOTS,'batch-rename.png')});
  }
  await input.press('Enter');
  await dialog.waitFor({state:'hidden'});
  await until(s=>s.batch_names[first.batch_id]===renamed);
  const queue=page.getByRole('region',{name:'Queued Fleet batches',exact:true});
  await queue.getByText(renamed,{exact:true}).waitFor();
  assert.deepEqual(await queue.locator('[data-batch-id]').evaluateAll(rows=>rows.map(r=>r.dataset.batchId)),[first.batch_id,second.batch_id]);
  assert.deepEqual((await state()).jobs,before.jobs);
  for(const number of [1,2]) await page.getByRole('region',{name:`Node ${number} activity`,exact:true}).getByText(renamed,{exact:true}).waitFor();
  const row=queue.locator(`[data-batch-id="${first.batch_id}"]`);
  assert.equal(await row.locator('summary').getAttribute('aria-label'),`Batch actions for ${renamed}`);
  await row.getByRole('button',{name:'Cancel batch',exact:true}).click();
  const cancel=page.getByRole('dialog',{name:`Cancel queued jobs in “${renamed}”?`,exact:true});
  await cancel.getByRole('button',{name:'Keep jobs',exact:true}).click();
  await post('/fixture',{restart:true});
  await page.reload();
  await queue.getByText(renamed,{exact:true}).waitFor();
  const reopened=await openBatchRename(page,first.batch_id);
  assert.equal(await reopened.getByRole('textbox',{name:'Batch name',exact:true}).inputValue(),renamed);
  await reopened.getByRole('button',{name:'Cancel',exact:true}).click();
});

test('batch rename supports cancellation, validates empty names, and retains input after a failed save',{timeout:30000},async t=>{
  const {page,submit,until,state}=await setup(t);
  const accepted=await submit('Original',5);
  await until(s=>s.jobs.filter(j=>j.acknowledged).length===2);
  let dialog=await openBatchRename(page,accepted.batch_id);
  await dialog.getByRole('textbox',{name:'Batch name',exact:true}).fill('   ');
  assert.equal(await dialog.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
  await dialog.press('Escape');
  assert.equal((await state()).batch_names[accepted.batch_id],'Original');
  dialog=await openBatchRename(page,accepted.batch_id);
  const input=dialog.getByRole('textbox',{name:'Batch name',exact:true});
  await input.fill('Retry this name');
  let release,received,requests=0;
  const held=new Promise(resolve=>{release=resolve});
  const seen=new Promise(resolve=>{received=resolve});
  t.after(()=>release());
  await page.route('**/fleet/batches/*/rename',async route=>{
    if(++requests===1)return route.abort('failed');
    received();await held;await route.continue();
  });
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await dialog.getByRole('alert').getByText(/^Could not rename batch\./).waitFor();
  assert.equal(await input.inputValue(),'Retry this name');
  assert.equal((await state()).batch_names[accepted.batch_id],'Original');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await seen;
  assert.equal(await dialog.getByRole('button',{name:'Saving…',exact:true}).isDisabled(),true);
  assert.equal(await dialog.getByRole('button',{name:'Cancel',exact:true}).isDisabled(),true);
  await dialog.press('Escape');
  assert.equal(await dialog.isVisible(),true);
  release();
  await dialog.waitFor({state:'hidden'});
  assert.equal((await state()).batch_names[accepted.batch_id],'Retry this name');
  assert.equal(requests,2);
});

test('batch rename rejects stale queue entries and malformed names through the HTTP API',{timeout:30000},async t=>{
  const {page,submit,until,state,post}=await setup(t,{nodeCount:1});
  const accepted=await submit('Original',2);
  const initial=await until(s=>s.jobs.some(j=>j.acknowledged));
  const url=new URL(`/fleet/batches/${accepted.batch_id}/rename`,page.url()).href;
  for(const data of [{name:''},{name:'x'.repeat(201)},{name:null},{name:'first\nsecond'},{}]) {
    assert.equal((await page.request.post(url,{data})).status(),400);
  }
  const active=initial.jobs.find(j=>j.acknowledged);
  await post('/fixture',{worker:active.worker_id,complete:active.remote_id});
  await until(s=>!s.jobs.some(j=>j.state==='waiting'));
  assert.equal((await page.request.post(url,{data:{name:'Too late'}})).status(),409);
  assert.equal((await state()).batch_names[accepted.batch_id],'Original');
});
