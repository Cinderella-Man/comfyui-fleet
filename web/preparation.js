// Frontend preparation semantics verified against native Run in baseline 1.52.7.
// Uses the real promoted-widget helper; no interception of other callers.
export function createBatchId(crypto = globalThis.crypto) {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID requires a secure context; getRandomValues also works on LAN HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function captureSource(app) {
  const source = JSON.parse(JSON.stringify(app.rootGraph.serialize()));
  delete source.extra?.fleet_edit_id;
  const filename = app.extensionManager?.workflow?.activeWorkflow?.filename;
  const name = typeof filename === "string" ? filename.replace(/\.json$/i, "").trim().slice(0, 200) : "";
  if (name && !app.rootGraph.extra?.fleet_edit_id) source.extra = { ...source.extra,
    fleet: { ...source.extra?.fleet, workflow_name: name } };
  return source;
}

function collect(current, ancestors = new Set()) {
  if (ancestors.has(current)) throw new Error("Cyclic graph hierarchy");
  const next = new Set(ancestors); next.add(current);
  if (next.size > 100) throw new Error("Graph hierarchy exceeds supported limit");
  const nodes = [];
  for (const node of current.nodes) {
    if (node.has_errors) throw new Error("Resolve missing workflow nodes before preparing jobs");
    if (node.isSubgraphNode?.() && node.subgraph) nodes.push(...collect(node.subgraph, next));
    nodes.push(node);
    if (nodes.length > 1024) throw new Error("Graph exceeds supported node limit");
  }
  return nodes;
}

// Obtain the native callback implementations from this frontend build. A widget
// name is not enough: custom extensions can install callbacks with private state.
export function nativeControls(addValueControlWidgets, promotedControl) {
  const node = { addWidget(type, name, value, callback, options) { return { type, name, value, callback, options }; } };
  const [widget] = addValueControlWidgets(node, { type: "number", name: "seed", value: 0, options: {} });
  return { beforeQueued: String(widget.beforeQueued), afterQueued: String(widget.afterQueued),
    promoted: String(promotedControl) };
}

function controlMode(app) {
  return app.ui?.settings?.getSettingValue("Comfy.WidgetControlMode") === "before" ? "before" : "after";
}

function checkControls(app, controls) {
  for (const node of collect(app.rootGraph)) for (const widget of node.widgets ?? []) {
    for (const phase of ["beforeQueued", "afterQueued"]) {
      if (widget[phase] && String(widget[phase]) !== controls?.[phase]) {
        throw new Error("This workflow has custom generation controls whose state cannot be resumed. Submit a new batch to add jobs.");
      }
    }
  }
}

export function captureContinuation(app, controls) {
  try {
    if (!controls) throw new Error("This frontend cannot save generation controls for batch growth. Reload Fleet or submit a new batch.");
    checkControls(app, controls);
    return { version: 1, workflow: captureSource(app), mode: controlMode(app), controls };
  } catch (error) { return { version: 1, error: error.message }; }
}

export function restoreContinuation(app, promotedControl, controls, saved) {
  if (!saved || saved.error) throw new Error(saved?.error || "This older batch has no saved generation state. Submit a new batch to add jobs.");
  if (!["beforeQueued", "afterQueued", "promoted"].every(key => saved.controls[key] === controls?.[key]) || saved.mode !== controlMode(app)) {
    throw new Error("ComfyUI’s generation controls changed since this batch was prepared. Restore its control mode or submit a new batch.");
  }
  checkControls(app, controls);
  // Before-generation controls skip their first invocation after loading. Prime
  // that flag without advancing any values, including promoted subgraph widgets.
  const options = { isPartialExecution: true };
  for (const node of collect(app.rootGraph)) {
    for (const widget of node.widgets ?? []) widget.beforeQueued?.(options);
    promotedControl(node, "beforeQueued", options);
  }
}

export async function prepareSnapshots(app, promotedControl, count, onPrepared = () => {}) {
  if (typeof promotedControl !== "function") throw new Error("Missing native promoted-widget helper");
  const graph = app.rootGraph;
  const filename = app.extensionManager?.workflow?.activeWorkflow?.filename;
  const workflowName = typeof filename === "string" ? filename.replace(/\.json$/i, "").trim().slice(0, 200) : "";
  const options = { isPartialExecution: false };
  const jobs = [];
  for (let index = 0; index < count; index++) {
    for (const node of collect(graph)) {
      for (const widget of node.widgets ?? []) widget.beforeQueued?.(options);
      promotedControl(node, "beforeQueued", options);
    }
    const snapshot = await app.graphToPrompt(graph);
    const queuedNodes = collect(graph);
    // Native submission sends JSON. Serialized graphs can still contain nested
    // reactive Proxies, which structuredClone rejects. Snapshot the wire data
    // before afterQueued mutates widget values for the next job.
    const job = JSON.parse(JSON.stringify({ output: snapshot.output, workflow: snapshot.workflow }));
    if (workflowName) job.workflow.extra = { ...job.workflow.extra,
      fleet: { ...job.workflow.extra?.fleet, workflow_name: workflowName } };
    jobs.push(job);
    onPrepared(jobs.length);
    for (const node of queuedNodes) for (const widget of node.widgets ?? []) widget.afterQueued?.(options);
    for (const node of queuedNodes) promotedControl(node, "afterQueued", options);
    app.canvas.draw(true, true);
  }
  return jobs;
}
