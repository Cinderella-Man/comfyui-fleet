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

export async function prepareSnapshots(app, promotedControl, count, onPrepared = () => {}) {
  if (typeof promotedControl !== "function") throw new Error("Missing native promoted-widget helper");
  const graph = app.rootGraph;
  const filename = app.extensionManager?.workflow?.activeWorkflow?.filename;
  const workflowName = typeof filename === "string" ? filename.replace(/\.json$/i, "").trim().slice(0, 200) : "";
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
