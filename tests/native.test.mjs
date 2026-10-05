// Run only against a disposable ComfyUI instance serving this Fleet checkout.
// Exercises real native widget callbacks, serialization and subgraph promotion.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const url=process.env.FLEET_NATIVE_URL;
test('native seed controls continue across serialization without replay, including promoted subgraphs',
  {skip:!url,timeout:180000},async()=>{
  const {chromium}=createRequire(import.meta.url)(process.env.FLEET_PLAYWRIGHT_MODULE || 'playwright');
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.goto(url);
    await page.locator('[data-testid=queue-button]').waitFor({timeout:60000});
    const results=await page.evaluate(async()=>{
      const {app}=await import('/scripts/app.js');
      const {addValueControlWidgets}=await import('/scripts/widgets.js');
      const {applyPromotedWidgetControl:promoted}=await import('/scripts/promotedWidgetControl.js');
      const p=await import('/extensions/ComfyUI-Fleet/preparation.js');
      const controls=p.nativeControls(addValueControlWidgets,promoted);
      const graph={last_node_id:1,last_link_id:0,nodes:[{id:1,type:'KSampler',pos:[0,0],size:[300,400],flags:{},order:0,mode:0,inputs:[],outputs:[],properties:{},widgets_values:[11,'increment',20,8,'euler','normal',1]}],links:[],groups:[],config:{},extra:{},version:0.4};
      const results=[];
      for(const nested of [false,true]) for(const mode of ['before','after']) {
        for(const action of ['increment','decrement','fixed','randomize']) {
          await app.ui.settings.setSettingValue('Comfy.WidgetControlMode',mode);
          await app.loadGraphData(structuredClone(graph),true,true,'Fleet control regression');
          app.rootGraph.nodes[0].widgets.find(w=>w.name==='control_after_generate').value=action;
          if(nested) {
            const {node}=app.rootGraph.convertToSubgraph(new Set([app.rootGraph.nodes[0]]));
            if(!node.inputs.some(input=>input.widgetId)) throw new Error('Expected promoted host widgets');
          }
          const initial=await p.prepareSnapshots(app,promoted,3);
          const saved=p.captureContinuation(app,controls);
          if(saved.error) throw new Error(saved.error);
          // Simulate a new browser's widget instances and controller JSON key ordering.
          const checkpoint=JSON.parse(JSON.stringify(saved));
          checkpoint.controls=Object.fromEntries(Object.entries(checkpoint.controls).sort());
          await app.loadGraphData(checkpoint.workflow,true,true,'Fleet resumed regression');
          p.restoreContinuation(app,promoted,controls,checkpoint);
          const addition=await p.prepareSnapshots(app,promoted,2);
          const seeds=initial.concat(addition).map(job=>Object.values(job.output).find(node=>node.class_type==='KSampler').inputs.seed);
          results.push({nested,mode,action,seeds});
        }
      }
      return results;
    });
    for(const result of results) {
      const context=JSON.stringify(result);
      if(result.action==='increment') assert.deepEqual(result.seeds,[11,12,13,14,15],context);
      if(result.action==='decrement') assert.deepEqual(result.seeds,[11,10,9,8,7],context);
      if(result.action==='fixed') assert.deepEqual(result.seeds,[11,11,11,11,11],context);
      if(result.action==='randomize') assert.notEqual(result.seeds[2],result.seeds[3],context);
    }
    assert.equal(results.length,16);
  } finally { await browser.close(); }
});
