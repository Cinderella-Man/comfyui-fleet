// UI uses ComfyUI's registered sidebar surface and ordinary DOM elements.
function element(tag, text, props = {}) {
  const item = document.createElement(tag);
  if (text != null) item.textContent = text;
  Object.assign(item, props);
  return item;
}

const terminal = new Set(["succeeded", "failed", "cancelled"]);
const pageSize = 10;

export function jobStatus(job) {
  if (!terminal.has(job.state) && job.cancel_requested) return "Cancelling";
  if (job.state === "unknown") return job.occupied ? "Checking job" : "Cancelled";
  if (job.collection_state === "error") return "Results need attention";
  if (terminal.has(job.state) && job.collection_state === "pending") return "Saving results";
  return { waiting: "Queued", preparing: "Preparing", outstanding: "In progress",
    succeeded: "Completed", failed: "Failed", cancelled: "Cancelled" }[job.state] ?? "Needs review";
}

function needsAttention(job) {
  if (job.state === "unknown" && !job.occupied) return false;
  return !terminal.has(job.state) || job.occupied || ["pending", "error"].includes(job.collection_state);
}

function stepProgress(job, snapshot = {}) {
  if (!job.occupied || job.state !== "outstanding" ||
      ["execution_success", "execution_error", "execution_interrupted"].some(type => snapshot[type])) return null;
  let detail = snapshot.progress;
  if (snapshot.progress_state) {
    const nodes = snapshot.progress_state.nodes ?? {};
    const running = Object.values(nodes).filter(node => node?.state === "running");
    const latest = nodes[detail?.node];
    detail = latest?.state === "running" ? latest : running.length === 1 ? running[0] : null;
  } else if (snapshot.executing && (snapshot.executing.node == null ||
      detail?.node !== snapshot.executing.node)) return null;
  // A new workflow step starts at 0/1 even when it cannot report real progress.
  if (!Number.isFinite(detail?.value) || !Number.isFinite(detail?.max) ||
      detail.max <= 1 || detail.value < 0 || detail.value > detail.max) return null;
  return Math.round(100 * detail.value / detail.max);
}

export function queuedJobs(jobs) {
  return jobs.filter(job => job.state === "waiting" && job.worker_id == null && !job.occupied && !job.submit_intent);
}

function batchSummaries(jobs, names = {}, counts = {}) {
  const batches = new Map();
  for (const job of jobs) {
    if (!batches.has(job.batch_id)) batches.set(job.batch_id, { id: job.batch_id,
      name: typeof names[job.batch_id] === "string" && names[job.batch_id].trim() ? names[job.batch_id].trim().slice(0, 200) : "Workflow batch",
      total: 0, completed: 0, failed: 0, cancelled: 0, active: 0, review: 0, queued: 0, created: job.created });
    const batch = batches.get(job.batch_id);
    batch.total++;
    batch.created = Math.min(batch.created, job.created);
    if (job.state === "succeeded") batch.completed++;
    else if (job.state === "failed") batch.failed++;
    else if (job.state === "cancelled") batch.cancelled++;
    else if (job.state === "unknown") batch.review++;
    else if (job.worker_id != null || job.occupied || job.submit_intent) batch.active++;
  }
  for (const job of queuedJobs(jobs)) batches.get(job.batch_id).queued++;
  for (const [id, batch] of batches) Object.assign(batch, counts[id] ?? {});
  return batches;
}

export function queuedBatches(jobs, names = {}, counts = {}) {
  const batches = batchSummaries(jobs, names, counts);
  // Assigned/completed jobs keep their old priority, so only waiting jobs define queue order.
  return [...new Set(queuedJobs(jobs).map(job => job.batch_id))].map(id => batches.get(id));
}

function batchTime(batch) {
  return "Added " + new Date(batch.created * 1000).toLocaleString(undefined,
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderBatchProgress(row, batch) {
  row.count.textContent = `${batch.completed} of ${batch.total} jobs completed`;
  row.progress.max = batch.total;
  row.progress.value = batch.completed;
  row.progress.setAttribute("aria-label", `${batch.name} completed jobs`);
}

export function workerJobs(jobs, workerId) {
  return jobs.filter(job => job.worker_id === workerId && !job.hidden && needsAttention(job));
}

// Normalize what people paste without weakening the server's private-address checks.
export function nodeAddress(value) {
  const raw = value.trim();
  if (!raw) throw new Error("Enter the node's ComfyUI address.");
  let url;
  try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`); }
  catch { throw new Error("Enter an IP address and port, like 192.168.1.20:8188."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("Use just the ComfyUI address, without a page path or login details.");
  }
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

export function nodeName(value, workers) {
  const name = value.trim().replace(/\s+/g, "-");
  if (name && !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error("Use a short name with letters, numbers, spaces or hyphens.");
  }
  if (name) {
    if (workers.some(worker => worker.id === name)) throw new Error("That name is already in your list. Choose another name.");
    return name;
  }
  let index = 1;
  while (workers.some(worker => worker.id === `node-${index}`)) index++;
  return `node-${index}`;
}

function nodeLabel(id) {
  return /^node-\d+$/.test(id) ? `Node ${id.slice(5)}` : id;
}

function memoryLabel(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? `${Number((bytes / 1024 ** 3).toFixed(1))} GiB` : null;
}

export function hardwareDetails(info) {
  const ram = memoryLabel(info?.ram_total);
  // Setup drafts survive in browser storage; tolerate older or malformed metadata.
  const reported = Array.isArray(info?.devices) ? info.devices : [];
  const devices = reported.filter(device => device &&
    (typeof device.name === "string" || typeof device.type === "string")).slice(0, 64).map(device => {
    const type = typeof device.type === "string" ? device.type : "";
    let name = (typeof device.name === "string" ? device.name.slice(0, 200) : "").replace(/^(?:cuda|xpu|npu|mlu|hip):\d+\s+/i, "")
      .replace(/\s+:\s*(?:cudaMallocAsync|native)?$/i, "").trim();
    if (name.toLowerCase() === "cpu") name = "CPU";
    if (name.toLowerCase() === "mps") name = "Apple GPU (Metal)";
    const memory = memoryLabel(device.vram_total);
    return { name: name || type.toUpperCase() || "Unknown device",
      memory: type === "cpu" ? null : memory ? `${memory} ${type === "mps" ? "shared memory" : "VRAM"}` : null };
  });
  const note = !info ? "Detecting hardware…" : info.available === false ?
    devices.length || ram ? "Last detected · unable to refresh" : "Hardware unavailable" :
    devices.length ? "" : "Device not reported";
  return { devices, ram: ram ? `${ram} RAM` : null, note };
}

export function suggestedNodeName(info, workers) {
  if (info?.available === false) return "";
  const devices = Array.isArray(info?.devices) ? info.devices : [];
  const gpu = devices.find(device => typeof device?.name === "string" && device.name.trim() &&
    device.type !== "cpu" && device.name.trim().toLowerCase() !== "cpu");
  if (!gpu) return "";
  // Use the same device label as the hardware card, within node-name limits.
  const base = hardwareDetails({ devices: [gpu] }).devices[0].name
    .replace(/[^A-Za-z0-9\s_-]/g, "").replace(/\s+/g, " ").trim().slice(0, 64).trim();
  if (!base) return "";
  let name = base, index = 2;
  while (workers.some(worker => worker.id === nodeName(name, []))) {
    const suffix = ` ${index++}`;
    name = `${base.slice(0, 64 - suffix.length).trimEnd()}${suffix}`;
  }
  return name;
}

function renderHardware(target, info) {
  const hardware = hardwareDetails(info);
  const signature = JSON.stringify(hardware);
  if (target.hardwareSignature === signature) return;
  target.hardwareSignature = signature;
  target.replaceChildren();
  for (const device of hardware.devices) {
    const label = element("span", null, { className: "fleet-worker-device" });
    label.append(element("span", device.name));
    if (device.memory) label.append(element("small", device.memory));
    target.append(label);
  }
  if (hardware.ram) target.append(element("small", hardware.ram));
  if (hardware.note) target.append(element("small", hardware.note));
}

function fleetMark() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of [
    ["path", { d: "M16 10v7M7 23v-6h18v6", fill: "none", stroke: "currentColor", "stroke-width": "1.5" }],
    ...[[11, 3], [2, 22], [20, 22]].map(([x, y]) => ["rect", { x, y, width: 10, height: 7, rx: 2, fill: "currentColor" }]),
  ]) {
    const child = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
    svg.append(child);
  }
  return svg;
}

function versionIssue(text) {
  const minimum = text.match(/Fleet requires (ComfyUI|frontend) (\S+) or newer/);
  const legacy = text.match(/requires verified ComfyUI (\S+) \/ frontend (\S+)/);
  if (!minimum && !legacy) return null;
  const found = text.match(/; found (ComfyUI|frontend) (\S+)/);
  return {
    description: minimum ? "Fleet needs a newer version of the component below before it can start." :
      "This Fleet build expects a specific ComfyUI and frontend version.",
    label: minimum ? "Minimum version" : "Expected by this build",
    versions: minimum ? [[minimum[1] === "frontend" ? "Frontend" : "ComfyUI", `${minimum[2]} or newer`]] :
      [["ComfyUI", legacy[1]], ["Frontend", legacy[2]]],
    installed: found ? `Installed: ${found[1] === "frontend" ? "Frontend" : "ComfyUI"} ${found[2]}` : null,
    next: minimum ? "Update the required component, then restart ComfyUI and refresh this page." :
      "Update Fleet to allow newer versions, then restart ComfyUI and refresh this page.",
  };
}

// Shared pointer/keyboard ordering for batches and node cards. Callers retain
// server snapshots; dragging freezes list rendering until save or cancellation.
class ReorderList {
  constructor(options) { Object.assign(this, options); this.drag = null; this.saving = false; }
  get busy() { return Boolean(this.drag) || this.saving; }
  ids() { return [...this.list.children].map(row => row.dataset[this.key]); }

  handle(id, name) {
    const handle = element("button", null, { type: "button", className: "fleet-drag-handle" });
    handle.setAttribute("aria-label", `Reorder ${name}`);
    handle.setAttribute("aria-describedby", this.descriptionId);
    handle.setAttribute("aria-pressed", "false");
    handle.title = "Drag to reorder. Or press Space, use arrow keys, then Space to save.";
    const grip = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    grip.setAttribute("viewBox", "0 0 18 24"); grip.setAttribute("aria-hidden", "true");
    for (const x of [6, 12]) for (const y of [6, 12, 18]) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", "1.5");
      dot.setAttribute("fill", "currentColor"); grip.append(dot);
    }
    handle.append(grip);
    handle.addEventListener("keydown", event => this.keydown(event, id, handle));
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary || handle.disabled) return;
      event.preventDefault();
      if (!this.start(id, handle, event.pointerId)) return;
      this.drag.startY = this.drag.y = event.clientY;
      this.scroll();
    });
    handle.addEventListener("pointermove", event => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.y = event.clientY;
      if (!drag.active && Math.abs(drag.y - drag.startY) < 5) return;
      drag.active = true; this.rows.get(id).root.dataset.dragging = "true";
      this.position();
    });
    handle.addEventListener("pointerup", event => {
      if (this.drag?.pointerId === event.pointerId) this.finish(true);
    });
    for (const type of ["pointercancel", "lostpointercapture"]) handle.addEventListener(type, () => this.finish(false));
    return handle;
  }

  start(id, handle, pointerId = null) {
    if (this.busy || this.isDisabled()) return;
    const order = this.ids();
    if (order.length < 2) return;
    this.drag = { id, handle, pointerId, originalOrder: order,
      before: order[order.indexOf(id) + 1] ?? null, active: pointerId == null };
    handle.focus({ preventScroll: true }); handle.setAttribute("aria-pressed", "true");
    if (pointerId != null) handle.setPointerCapture(pointerId);
    else {
      this.rows.get(id).root.dataset.dragging = "true";
      this.announce(`${this.subject} picked up. Use arrow keys to move, Space to save, or Escape to cancel.`);
    }
    this.render();
    return true;
  }

  position() {
    const drag = this.drag;
    if (!drag?.active || drag.pointerId == null) return;
    const others = [...this.list.children].filter(row => row.dataset[this.key] !== drag.id);
    const target = others.find(row => drag.y < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    for (const row of this.rows.values()) delete row.root.dataset.drop;
    drag.before = target?.dataset[this.key] ?? null;
    if (target) target.dataset.drop = "before";
    else if (others.length) others.at(-1).dataset.drop = "after";
  }

  scroll() {
    const tick = () => {
      const drag = this.drag;
      if (!drag || drag.pointerId == null) return;
      if (drag.active) {
        const box = this.scroller.getBoundingClientRect(), edge = 36;
        const speed = drag.y < box.top + edge ? -Math.min(14, (box.top + edge - drag.y) / 3) :
          drag.y > box.bottom - edge ? Math.min(14, (drag.y - box.bottom + edge) / 3) : 0;
        if (speed) { this.scroller.scrollTop += speed; this.position(); }
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  keydown(event, id, handle) {
    if (!this.drag) {
      if ([" ", "Enter"].includes(event.key)) { event.preventDefault(); this.start(id, handle); }
      return;
    }
    if (this.drag.id !== id) return;
    if (["Escape", "Tab"].includes(event.key)) {
      if (event.key === "Escape") event.preventDefault();
      this.finish(false);
    } else if ([" ", "Enter"].includes(event.key)) {
      event.preventDefault(); this.finish(true);
    } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) && this.drag.pointerId == null) {
      event.preventDefault();
      const order = this.ids(), index = order.indexOf(id);
      const next = event.key === "Home" ? 0 : event.key === "End" ? order.length - 1 :
        Math.max(0, Math.min(order.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
      order.splice(index, 1); order.splice(next, 0, id);
      this.drag.before = order[next + 1] ?? null;
      this.list.insertBefore(this.rows.get(id).root, this.drag.before ? this.rows.get(this.drag.before).root : null);
      handle.focus({ preventScroll: true }); this.rows.get(id).root.scrollIntoView({ block: "nearest" });
      this.announce(`Position ${next + 1} of ${order.length}. Press Space to save or Escape to cancel.`);
    }
  }

  finish(commit) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null; cancelAnimationFrame(this.frame);
    drag.handle.setAttribute("aria-pressed", "false");
    if (drag.pointerId != null && drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    for (const row of this.rows.values()) { delete row.root.dataset.dragging; delete row.root.dataset.drop; }
    const order = drag.originalOrder.filter(id => id !== drag.id);
    order.splice(drag.before == null ? order.length : order.indexOf(drag.before), 0, drag.id);
    if (commit && drag.active && order.join() !== drag.originalOrder.join()) {
      this.list.insertBefore(this.rows.get(drag.id).root, drag.before ? this.rows.get(drag.before).root : null);
      void this.persist(drag.id, drag.before);
    } else {
      if (drag.active) this.complete(commit ? `${this.subject} order unchanged.` : "Reordering cancelled.");
      this.render();
    }
  }

  async persist(id, before) {
    this.saving = true;
    this.announce(`Saving ${this.subject.toLowerCase()} order…`); this.render();
    try {
      await this.save(id, before);
      this.complete(`${this.subject} order saved. Active jobs keep running.`);
    } catch (error) {
      try { await this.reload?.(); } catch { /* Keep the last confirmed snapshot. */ }
      this.announce(`Could not reorder ${this.plural}. ${error.message}`, true);
    } finally {
      this.saving = false; this.render();
      this.rows.get(id)?.handle.focus({ preventScroll: true });
    }
  }

  complete(text) {
    this.announce("");
    this.notify(text);
  }
}

export class FleetPanel {
  constructor(actions) {
    this.actions = actions;
    this.queueRows = new Map();
    this.workerPages = new Map();
    this.cancellingQueue = false;
    this.cancellingBatches = new Set();
    this.cancellingActive = false;
    this.cancellingJobs = new Set();
    this.jobCancellationErrors = new Map();
    this.editing = false;
    this.busy = null;
    this.nodeEdit = 0;
    this.initialized = false;
    this.workerRows = new Map();
    this.draftHardware = new Map();
    this.workerSaving = null;
    this.workerError = null;
    this.root = element("section", null, { className: "fleet-panel" });
    const header = element("header", null, { className: "fleet-header" });
    const mark = element("span", null, { className: "fleet-mark" });
    mark.append(fleetMark());
    this.modeBadge = element("span", "Setup", { className: "fleet-mode", hidden: true });
    this.cancelActiveButton = element("button", "Cancel active jobs", { type: "button", className: "fleet-danger fleet-cancel-active" });
    this.cancelActiveButton.title = "Cancel jobs currently assigned to nodes. Queued jobs can still start; cancel them separately to stop all work.";
    this.cancelActiveButton.addEventListener("click", () => this.cancelActive());
    header.append(mark, element("h2", "Fleet"), this.modeBadge);
    this.cancelFeedback = element("p", null, { className: "fleet-cancel-feedback", hidden: true });
    this.cancelFeedback.setAttribute("role", "status");
    this.status = element("p", "Connecting…", { className: "fleet-status" });
    this.status.setAttribute("role", "status");
    this.notification = element("div", null, { className: "fleet-notification", hidden: true });
    this.notification.setAttribute("role", "status");
    this.notificationText = element("span");
    const dismiss = this.button("×", () => this.dismissNotification());
    dismiss.setAttribute("aria-label", "Dismiss notification");
    this.notification.append(this.notificationText, dismiss);
    this.versionNotice = element("section", null, { className: "fleet-version-notice", hidden: true });
    this.versionNotice.setAttribute("role", "alert");
    this.dashboard = element("div", null, { hidden: true });
    const queue = element("section", null, { className: "fleet-queue" });
    queue.setAttribute("aria-label", "Queued Fleet batches");
    const queueHeading = element("div", null, { className: "fleet-queue-heading" });
    const queueTitle = element("h3", "Queue ");
    this.queueCount = element("span", null, { className: "fleet-queue-count" });
    queueTitle.append(this.queueCount);
    this.cancelQueueButton = element("button", "Cancel queued jobs", { type: "button", className: "fleet-danger" });
    this.cancelQueueButton.title = "Cancel waiting jobs and let assigned work finish.";
    this.cancelQueueButton.addEventListener("click", () => this.cancelQueued());
    queueHeading.append(queueTitle, this.cancelQueueButton);
    this.queueHint = element("p", null, { className: "fleet-queue-hint" });
    this.queueBody = element("div", null, { className: "fleet-queue-body" });
    this.queueList = element("ol", null, { className: "fleet-queue-list" });
    this.queueEmpty = element("p", "No batches waiting", { className: "fleet-queue-empty" });
    this.queueBody.append(this.queueList, this.queueEmpty);
    this.dragHelp = element("span", "Press Space to pick up a batch, use the arrow keys to move it, then Space to save. Escape cancels.", { className: "fleet-sr-only", id: "fleet-drag-help" });
    this.queueFeedback = element("p", null, { className: "fleet-queue-feedback", hidden: true });
    this.queueFeedback.setAttribute("role", "status");
    queue.append(queueHeading, this.queueHint, this.queueBody, this.queueFeedback, this.dragHelp);
    const nodesHeading = element("div", null, { className: "fleet-nodes-heading" });
    nodesHeading.append(element("h3", "Your nodes"), this.cancelActiveButton);
    this.workers = element("ul", null, { className: "fleet-node-summary" });
    this.workers.setAttribute("aria-label", "Your nodes");
    const nodeHint = element("p", "Drag nodes to set priority. The first available node gets the next job.", { className: "fleet-queue-hint" });
    this.nodeFeedback = element("p", null, { className: "fleet-node-feedback", hidden: true });
    this.nodeFeedback.setAttribute("role", "status");
    const nodeDragHelp = element("span", "Press Space to pick up a node, use arrow keys to move it, then Space to save. Escape cancels.", { className: "fleet-sr-only", id: "fleet-node-drag-help" });
    const orderingDisabled = () => this.editing || this.workerSaving || this.cancellingActive || this.cancellingQueuedJobs || !this.state?.ready;
    const renderOrder = () => { this.renderQueue(); this.renderWorkers(); };
    this.queueOrder = new ReorderList({ list: this.queueList, scroller: this.root, rows: this.queueRows,
      key: "batchId", subject: "Batch", plural: "batches", descriptionId: "fleet-drag-help",
      isDisabled: () => Boolean(this.state?.edit) || orderingDisabled() || this.workerOrder.busy, render: renderOrder,
      announce: (text, error) => this.queueMessage(text, error),
      notify: text => this.notify(text),
      save: (id, before) => this.actions.reorderBatch(id, before), reload: () => this.actions.retry?.() });
    this.workerOrder = new ReorderList({ list: this.workers, scroller: this.root, rows: this.workerRows,
      key: "workerId", subject: "Node", plural: "nodes", descriptionId: "fleet-node-drag-help",
      isDisabled: () => orderingDisabled() || this.queueOrder.busy, render: renderOrder,
      announce: (text, error = false) => {
        this.nodeFeedback.textContent = text; this.nodeFeedback.dataset.error = String(error); this.nodeFeedback.hidden = !text;
      },
      notify: text => this.notify(text),
      save: (id, before) => this.actions.reorderWorker(id, before), reload: () => this.actions.retry?.() });
    this.manageNodesButton = this.button("Manage nodes", () => this.beginSetup(this.state.workers));
    this.manageNodesButton.className = "fleet-secondary fleet-wide";
    const recovery = element("details", null, { className: "fleet-recovery" });
    this.backupFeedback = element("p", null, { className: "fleet-backup-feedback", hidden: true });
    this.backupFeedback.setAttribute("role", "status");
    const backup = this.button("Back up nodes", () => this.saveBackup());
    backup.className = "fleet-secondary fleet-wide";
    recovery.append(element("summary", "Backup & recovery"),
      element("p", "Save node names, addresses, enabled states and their order. Jobs, workflows and files are not included."),
      element("p", "Saved on the ComfyUI server, in the user folder under fleet/backups."),
      backup, this.backupFeedback);
    this.dashboard.append(queue, nodesHeading, nodeHint, this.cancelFeedback, this.nodeFeedback, this.workers, nodeDragHelp, this.manageNodesButton, recovery);
    this.setup = element("section", null, { className: "fleet-setup", hidden: true });
    this.setupContent = element("div", null, { className: "fleet-setup-content" });
    this.setupTitle = element("h3");
    this.setupIntro = element("p", null, { className: "fleet-intro" });
    this.nodeList = element("div", null, { className: "fleet-node-list" });
    this.nodeList.setAttribute("aria-label", "Nodes in your setup");
    this.listTitle = element("h4", null, { className: "fleet-list-title", hidden: true });
    this.nodeForm = element("form", null, { className: "fleet-node-form" });
    this.formFields = element("fieldset");
    this.formLegend = element("legend", "Node details");
    const addressLabel = element("label", "ComfyUI address");
    this.addressInput = element("input", null, { type: "text", placeholder: "192.168.1.20:8188", autocomplete: "off", spellcheck: false });
    this.addressInput.setAttribute("inputmode", "url");
    const addressWrap = element("span", null, { className: "fleet-address-wrap" });
    this.addressIcon = element("span", null, { className: "fleet-address-icon", hidden: true });
    this.addressIcon.setAttribute("aria-hidden", "true");
    addressWrap.append(this.addressInput, this.addressIcon);
    addressLabel.append(addressWrap);
    this.addressHint = element("p", "Use the node's private IP address and port.", { className: "fleet-field-hint", id: "fleet-address-hint" });
    this.addressHint.setAttribute("role", "status");
    this.addressError = element("p", null, { className: "fleet-inline-error", id: "fleet-address-error", hidden: true });
    this.addressError.setAttribute("role", "alert");
    this.addressHardwareBox = element("div", null, { className: "fleet-detected-hardware", hidden: true });
    this.addressHardwareBox.setAttribute("role", "group");
    this.addressHardwareBox.setAttribute("aria-label", "Detected hardware");
    this.addressHardware = element("span", null, { className: "fleet-worker-hardware", id: "fleet-address-hardware" });
    this.addressHardware.setAttribute("aria-live", "polite");
    this.addressHardwareBox.append(element("strong", "Hardware"), this.addressHardware);
    this.addressInput.setAttribute("aria-describedby", "fleet-address-hint fleet-address-error fleet-address-hardware");
    this.addressInput.addEventListener("input", () => {
      this.resetAddressCheck();
      if (!this.nameEdited) this.nameInput.value = "";
      if (this.addressInput.value.trim()) this.addressTimer = setTimeout(() => this.verifyAddress(), 200);
    });
    this.addressInput.addEventListener("blur", event => {
      if (![this.cancelNodeButton, this.doneButton, this.backButton].includes(event.relatedTarget)) this.verifyAddress();
    });
    const nameLabel = element("label", "Name ");
    nameLabel.append(element("span", "(optional)", { className: "fleet-muted" }));
    this.nameInput = element("input", null, { type: "text", placeholder: "e.g. studio-pc", autocomplete: "off", maxLength: 64 });
    this.nameInput.addEventListener("input", () => { this.nameEdited = true; });
    nameLabel.append(this.nameInput);
    this.addButton = element("button", "Add node", { type: "submit" });
    this.addButton.className = "fleet-secondary fleet-add-node";
    this.formFields.append(this.formLegend, addressLabel, this.addressError, this.addressHint,
      this.addressHardwareBox, nameLabel);
    this.cancelNodeButton = this.button("Cancel", () => this.cancelNode());
    this.cancelNodeButton.className = "fleet-cancel-node";
    const formActions = element("div", null, { className: "fleet-form-actions" });
    formActions.append(this.addButton, this.cancelNodeButton);
    this.nodeForm.append(this.formFields, formActions);
    this.addAnotherButton = this.button("Add another node", () => {
      this.formOpen = true; this.updateSetupActions(); this.persistDraft(); this.addressInput.focus();
    });
    this.addAnotherButton.className = "fleet-secondary fleet-wide";
    this.nodeForm.addEventListener("submit", event => { event.preventDefault(); this.addNode(); });
    this.nodeForm.addEventListener("input", () => { this.setupError.hidden = true; this.persistDraft(); this.updateSetupActions(); });
    this.setupError = element("div", null, { className: "fleet-error fleet-setup-error", hidden: true, tabIndex: -1 });
    this.setupError.setAttribute("role", "alert");
    const help = element("details", null, { className: "fleet-help" });
    help.append(element("summary", "What is a node?"),
      element("p", "A node is a running ComfyUI instance, on this computer or another machine. Fleet sends a complete workflow job to each available node."),
      element("p", "Start ComfyUI on each node first. Each one needs the models and custom nodes used by your workflow."));
    this.setupFooter = element("footer", null, { className: "fleet-setup-footer" });
    const setupActions = element("div", null, { className: "fleet-setup-actions" });
    this.doneButton = this.button("Done", () => this.finishSetup());
    this.doneButton.className = "fleet-primary";
    this.backButton = this.button("Discard changes", async () => {
      if (!await this.confirmAction("Discard unsaved changes?",
        "Your unsaved node changes and any unfinished node details will be lost. Your saved nodes and running jobs will stay unchanged.",
        "Discard changes", "Keep editing")) return;
      this.resetAddressCheck();
      this.forgetDraft(); this.editing = false; this.updateView();
      this.manageNodesButton.focus();
    });
    this.backButton.className = "fleet-danger";
    this.footerHint = element("p", null, { className: "fleet-footer-hint" });
    setupActions.append(this.doneButton, this.backButton);
    this.setupFooter.append(setupActions, this.footerHint);
    this.setupContent.append(this.setupTitle, this.setupIntro, this.listTitle, this.nodeList,
      this.addAnotherButton, this.nodeForm, this.setupError, help);
    this.setup.append(this.setupContent, this.setupFooter);
    this.root.append(header, this.status, this.notification, this.versionNotice, this.setup, this.dashboard);
    this.root.addEventListener("click", e => e.stopPropagation());
    const style = element("style", `
      .fleet-panel{--fleet-accent:#93dfc3;--fleet-accent-ink:#122c24;--fleet-muted:#a9b1b8;--fleet-line:rgba(153,167,180,.22);--fleet-surface:rgba(153,167,180,.055);box-sizing:border-box;padding:20px;font:13px/1.5 system-ui;color:var(--fg-color,#e9edf0);overflow:auto;height:100%;min-width:0}
      .fleet-panel[data-setup=true]{display:flex;flex-direction:column;overflow:hidden;padding-bottom:0}
      .fleet-panel[data-setup=true]>:not(.fleet-setup){flex-shrink:0}
      .fleet-panel .fleet-setup{display:flex;flex-direction:column;flex:1;min-height:0}
      .fleet-panel .fleet-setup-content{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scroll-padding-block:12px;margin-right:-20px;padding-right:20px;padding-bottom:16px}
      .fleet-panel *{box-sizing:border-box}.fleet-panel [hidden]{display:none!important}
      .fleet-panel h2,.fleet-panel h3,.fleet-panel h4,.fleet-panel p{padding:0}
      .fleet-panel .fleet-header{display:flex;align-items:center;gap:10px;margin:0 0 24px}
      .fleet-panel h2{font-size:18px;font-weight:650;letter-spacing:-.3px;margin:0}
      .fleet-panel .fleet-mark{width:30px;height:30px;display:grid;place-items:center;color:var(--fleet-accent)}
      .fleet-panel .fleet-mark svg{width:28px;height:28px}
      .fleet-panel .fleet-mode{margin-left:auto;color:var(--fleet-muted);font-size:11px;border:1px solid var(--fleet-line);border-radius:20px;padding:3px 9px}
      .fleet-panel .fleet-setup-content>h3{font-size:25px;line-height:1.2;font-weight:650;letter-spacing:-.65px;margin:0 0 12px}
      .fleet-panel .fleet-intro{color:var(--fleet-muted);font-size:13px;line-height:1.65;margin:0 0 24px}
      .fleet-panel button{font:inherit;border:1px solid var(--fleet-line);border-radius:7px;padding:8px 10px;background:var(--fleet-surface);color:inherit;cursor:pointer;line-height:1.4;min-height:36px;transition:background .12s,border-color .12s}
      .fleet-panel button:hover:not(:disabled){background:rgba(153,167,180,.14);border-color:rgba(153,167,180,.45)}
      .fleet-panel button:disabled{opacity:.4;cursor:default}
      .fleet-panel .fleet-danger{color:#f2a6a6;border-color:rgba(242,166,166,.3);background:rgba(242,166,166,.045)}
      .fleet-panel .fleet-danger:hover:not(:disabled){color:#ffd0d0;border-color:rgba(242,166,166,.6);background:rgba(242,166,166,.12)}
      .fleet-panel .fleet-danger:disabled{color:var(--fleet-muted);border-color:var(--fleet-line);background:transparent}
      .fleet-panel .fleet-cancel-active{margin-left:auto;font-size:11px;padding:6px 9px;min-height:32px}
      .fleet-panel .fleet-cancel-feedback{font-size:11px;line-height:1.5;color:var(--fleet-muted);margin:0 0 10px}
      .fleet-panel .fleet-cancel-feedback[data-error=true]{color:#f2a6a6}
      .fleet-panel button:focus-visible,.fleet-panel summary:focus-visible{outline:2px solid var(--fleet-accent);outline-offset:3px}
      .fleet-panel .fleet-wide{width:100%}.fleet-panel .fleet-primary{background:var(--fleet-accent);border-color:var(--fleet-accent);color:var(--fleet-accent-ink);font-weight:650;min-height:42px}
      .fleet-panel .fleet-primary:hover:not(:disabled){background:#b0eed7;border-color:#b0eed7}
      .fleet-panel .fleet-primary:disabled{background:var(--fleet-surface);border-color:var(--fleet-line);color:var(--fleet-muted);opacity:.65}
      .fleet-panel .fleet-secondary{font-weight:550}
      .fleet-panel .fleet-node-form{border:1px solid var(--fleet-line);border-radius:12px;background:var(--fleet-surface);padding:16px;margin:0}
      .fleet-panel fieldset{border:0;padding:0;margin:0;min-width:0}
      .fleet-panel legend{font-size:13px;font-weight:600;margin:0 0 15px;padding:0}
      .fleet-panel label{display:block;font-size:12px;font-weight:550}
      .fleet-panel input{display:block;width:100%;min-width:0;margin:7px 0 0;padding:10px 11px;border:1px solid var(--fleet-line);border-radius:7px;font:13px/1.4 system-ui;color:inherit;background:var(--comfy-input-bg,#1b1d20);outline:none}
      .fleet-panel input::placeholder{color:#7e8992;opacity:1}.fleet-panel input:focus{border-color:var(--fleet-accent);box-shadow:0 0 0 2px rgba(147,223,195,.12)}
      .fleet-panel input[aria-invalid=true]{border-color:#f2a6a6;box-shadow:0 0 0 2px rgba(242,166,166,.12)}
      .fleet-panel .fleet-address-wrap{position:relative;display:block}
      .fleet-panel .fleet-address-wrap input{padding-right:36px}
      .fleet-panel .fleet-address-icon{position:absolute;right:12px;top:50%;transform:translateY(-50%);display:grid;place-items:center;width:16px;height:16px;line-height:1;color:var(--fleet-accent);font-size:16px}
      .fleet-panel .fleet-address-icon[data-state=checking]:before{content:"";width:14px;height:14px;border:2px solid var(--fleet-line);border-top-color:var(--fleet-accent);border-radius:50%;animation:fleet-address-spin .75s linear infinite}
      .fleet-panel .fleet-address-icon[data-state=invalid]{color:#f2a6a6;font-size:20px}
      @keyframes fleet-address-spin{to{transform:rotate(360deg)}}
      @media(prefers-reduced-motion:reduce){.fleet-panel .fleet-address-icon[data-state=checking]:before{animation:none}}
      .fleet-panel .fleet-inline-error{font-size:11px;color:#f2a6a6;margin:7px 0 18px;line-height:1.5}
      .fleet-panel .fleet-field-hint{font-size:11px;color:var(--fleet-muted);margin:7px 0 18px;line-height:1.5}
      .fleet-panel .fleet-detected-hardware{border:1px solid var(--fleet-line);border-radius:8px;background:var(--fleet-surface);padding:10px 12px;margin:12px 0 18px}
      .fleet-panel .fleet-detected-hardware>strong{font-size:11px;font-weight:550;color:var(--fleet-muted)}
      .fleet-panel .fleet-detected-hardware .fleet-worker-hardware{margin-bottom:0}
      .fleet-panel .fleet-form-actions{display:flex;gap:8px;margin-top:18px}
      .fleet-panel .fleet-form-actions button{min-width:0;min-height:40px}
      .fleet-panel .fleet-add-node{flex:2}
      .fleet-panel .fleet-cancel-node{flex:1;background:transparent;color:var(--fleet-muted)}
      .fleet-panel .fleet-muted{color:var(--fleet-muted);font-weight:400}
      .fleet-panel .fleet-list-title{font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:var(--fleet-muted);font-weight:600;margin:0 0 10px}
      .fleet-panel .fleet-node-list{display:grid;gap:8px;margin:0 0 14px}
      .fleet-panel .fleet-node-card{border:1px solid var(--fleet-line);border-radius:10px;padding:12px;background:var(--fleet-surface)}
      .fleet-panel .fleet-node-heading{display:flex;gap:10px;align-items:flex-start}
      .fleet-panel .fleet-node-copy{flex:1;min-width:0}.fleet-panel .fleet-node-copy strong{font-size:13px;overflow-wrap:anywhere}
      .fleet-panel .fleet-node-address{font-size:11px;color:var(--fleet-muted);display:block;overflow-wrap:anywhere;margin:2px 0 6px}
      .fleet-panel .fleet-remove{font-size:11px;padding:6px 9px;min-height:32px;flex-shrink:0}
      .fleet-panel .fleet-help{margin:20px 0;color:var(--fleet-muted);font-size:12px}
      .fleet-panel summary{cursor:pointer}.fleet-panel .fleet-help p{margin:10px 0;line-height:1.65}
      .fleet-panel .fleet-setup-footer{flex-shrink:0;padding:14px 0 18px;background:var(--comfy-menu-bg,#171717);border-top:1px solid var(--fleet-line)}
      .fleet-panel .fleet-setup-actions{display:flex;gap:8px}
      .fleet-panel .fleet-setup-actions .fleet-primary{flex:1}
      .fleet-panel .fleet-footer-hint{color:var(--fleet-muted);text-align:center;font-size:11px;line-height:1.5;margin:9px 0 0}
      .fleet-panel .fleet-error{border-left:2px solid #f2a6a6;color:#f2a6a6;padding:9px 11px;margin:12px 0;font-size:12px;overflow-wrap:anywhere}
      .fleet-panel .fleet-setup-error{border:1px solid #f2a6a655;border-radius:10px;background:linear-gradient(135deg,#f2a6a60c,var(--fleet-surface));padding:14px 16px;line-height:1.6}
      .fleet-panel .fleet-setup-error strong{display:block;font-size:13px;margin-bottom:6px}
      .fleet-panel .fleet-setup-error p{color:var(--fg-color,#e9edf0);margin:0;font-size:12px}
      .fleet-panel .fleet-status{font-size:12px;color:var(--fleet-muted);margin:0 0 16px}
      .fleet-panel .fleet-notification{display:flex;align-items:center;gap:10px;border:1px solid var(--fleet-line);border-radius:8px;padding:10px 12px;margin:0 0 16px;color:var(--fleet-accent);font-size:12px;background:var(--fleet-surface)}
      .fleet-panel .fleet-notification span{flex:1;min-width:0;overflow-wrap:anywhere}
      .fleet-panel .fleet-notification button{flex:none;border:0;background:transparent;padding:3px;min-width:28px;min-height:28px;font-size:18px}
      .fleet-panel .fleet-confirm{width:min(420px,calc(100vw - 32px));max-width:none;padding:22px;border:1px solid var(--fleet-line);border-radius:14px;background:var(--comfy-menu-bg,#202223);color:var(--fg-color,#e9edf0);box-shadow:0 16px 64px #0008;font:13px/1.65 system-ui}
      .fleet-panel .fleet-confirm::backdrop{background:rgba(0,0,0,.65)}
      .fleet-panel .fleet-confirm h3{margin:0 0 10px;font-size:18px;line-height:1.4;overflow-wrap:anywhere}
      .fleet-panel .fleet-confirm p{margin:0 0 18px;color:var(--fleet-muted)}
      .fleet-panel .fleet-confirm footer{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
      .fleet-panel .fleet-rename-field{margin-bottom:18px}
      .fleet-panel .fleet-rename-error{color:#f2a6a6}
      .fleet-panel .fleet-version-notice{border:1px solid rgba(226,177,106,.3);border-radius:14px;padding:20px;background:linear-gradient(145deg,rgba(226,177,106,.075),var(--fleet-surface) 65%);margin:0 0 20px;overflow-wrap:anywhere}
      .fleet-panel .fleet-version-icon{display:grid;place-items:center;width:40px;height:40px;border:1px solid rgba(226,177,106,.25);border-radius:12px;background:rgba(226,177,106,.1);color:#e2b16a;margin-bottom:18px}
      .fleet-panel .fleet-version-icon svg{width:22px;height:22px}
      .fleet-panel .fleet-version-label{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--fleet-muted);font-weight:600;margin:0 0 6px}
      .fleet-panel .fleet-version-notice h3{font-size:22px;font-weight:650;letter-spacing:-.5px;line-height:1.25;margin:0 0 10px}
      .fleet-panel .fleet-version-description{font-size:13px;line-height:1.65;color:var(--fleet-muted);margin:0 0 20px}
      .fleet-panel .fleet-version-requirements{border:1px solid var(--fleet-line);border-radius:9px;padding:12px;margin-bottom:18px;background:var(--fleet-surface)}
      .fleet-panel .fleet-version-requirements dl{margin:0}
      .fleet-panel .fleet-version-row{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px 12px;padding:6px 0;font-size:12px}
      .fleet-panel .fleet-version-row dt{color:var(--fleet-muted)}
      .fleet-panel .fleet-version-row dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
      .fleet-panel .fleet-version-installed{border-top:1px solid var(--fleet-line);padding-top:10px;margin:6px 0 0;font-size:11px;color:var(--fleet-muted)}
      .fleet-panel .fleet-version-next{font-size:12px;line-height:1.65;margin:0 0 18px}
      .fleet-panel .fleet-version-details{border-top:1px solid var(--fleet-line);padding-top:14px;margin:18px 0 0;font-size:11px;color:var(--fleet-muted)}
      .fleet-panel .fleet-version-details summary{padding:2px 0}
      .fleet-panel .fleet-version-details pre{font:11px/1.65 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0}
      .fleet-panel h3{font-size:14px;margin:22px 0 10px}
      .fleet-panel .fleet-queue-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
      .fleet-panel .fleet-queue-heading h3{margin:0;display:flex;align-items:center;gap:7px}
      .fleet-panel .fleet-queue-count{font-size:11px;color:var(--fleet-muted);font-weight:400}
      .fleet-panel .fleet-queue-heading button{font-size:11px;padding:5px 8px;min-height:30px}
      .fleet-panel .fleet-queue-hint{font-size:12px;line-height:1.65;color:var(--fleet-muted);margin:0 0 12px}
      .fleet-panel .fleet-queue-body{padding:3px;margin:-3px}
      .fleet-panel .fleet-queue-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
      .fleet-panel .fleet-batch{position:relative;display:grid;grid-template-columns:24px minmax(0,1fr);align-items:center;gap:10px;padding:12px 10px;border:1px solid var(--fleet-line);border-radius:10px;background:var(--fleet-surface)}
      .fleet-panel .fleet-batch strong{display:block;font-size:12px;font-weight:550;overflow-wrap:anywhere;line-height:1.5}
      .fleet-panel .fleet-batch small{display:block;font-size:10px;line-height:1.5;color:var(--fleet-muted);margin-top:3px}
      .fleet-panel .fleet-batch-heading>strong{min-width:0;overflow-wrap:anywhere}.fleet-panel .fleet-batch-heading>strong input{margin:0}.fleet-panel .fleet-batch-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}
.fleet-batch-menu{position:relative;flex:none}
.fleet-batch-menu summary{cursor:pointer;list-style:none;font-size:22px;padding:0 6px;border-radius:5px}
.fleet-batch-menu[open] summary{background:var(--comfy-input-bg,#333)}
.fleet-batch-menu .fleet-batch-actions{position:absolute;right:0;top:100%;display:flex;flex-direction:column;white-space:nowrap;z-index:20;padding:4px;border:1px solid var(--fleet-line);border-radius:8px;background:var(--comfy-menu-bg,#222);box-shadow:0 4px 16px #0008}
.fleet-batch-menu .fleet-batch-actions button{text-align:left;border-color:transparent}
.fleet-edit-shield{position:fixed;z-index:999;display:grid;place-items:center;background:#111b;color:#eee;font:16px system-ui;cursor:wait}
.fleet-edit-shield[hidden]{display:none}
.fleet-edit-bar{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:1000;display:flex;align-items:center;gap:12px;padding:12px 16px;max-width:calc(100vw - 32px);border:1px solid #777;border-radius:10px;background:var(--comfy-menu-bg,#222);color:var(--input-text,#eee);box-shadow:0 4px 20px #0008;font:14px system-ui}
.fleet-edit-bar[hidden]{display:none}
.fleet-edit-bar button{white-space:nowrap;padding:8px 12px;border:1px solid #777;border-radius:6px;background:var(--comfy-input-bg,#333);color:inherit;cursor:pointer}
.fleet-edit-bar button:disabled{opacity:.5;cursor:default}
.fleet-batch-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px}
      .fleet-panel .fleet-batch-footer small{margin:0;min-width:0}
      .fleet-panel .fleet-batch-footer button{flex:none;font-size:10px;padding:4px 7px;min-height:28px}
      .fleet-panel .fleet-batch-count{font-size:11px;color:var(--fleet-text);margin:7px 0 0;line-height:1.5}
      .fleet-panel .fleet-progress{display:block;width:100%;height:3px;border:0;border-radius:4px;margin:8px 0 6px;overflow:hidden;background:var(--fleet-line);appearance:none}
      .fleet-panel .fleet-progress::-webkit-progress-bar{background:var(--fleet-line)}
      .fleet-panel .fleet-progress::-webkit-progress-value{background:var(--fleet-accent)}
      .fleet-panel .fleet-progress::-moz-progress-bar{background:var(--fleet-accent)}
      .fleet-panel .fleet-drag-handle{padding:5px 2px;min-width:24px;min-height:40px;border:0;background:transparent;color:var(--fleet-muted);cursor:grab;touch-action:none;user-select:none}
      .fleet-panel .fleet-drag-handle svg{display:block;width:18px;height:24px;pointer-events:none}
      .fleet-panel .fleet-drag-handle:disabled{cursor:default;opacity:.35}
      .fleet-panel .fleet-drag-handle:focus-visible{outline:2px solid var(--fleet-accent);outline-offset:2px}
      .fleet-panel [data-dragging=true]{opacity:.55;border-color:var(--fleet-accent)}
      .fleet-panel [data-dragging=true] .fleet-drag-handle{cursor:grabbing}
      .fleet-panel [data-drop=before]::before,.fleet-panel [data-drop=after]::after{content:"";position:absolute;left:0;right:0;height:3px;border-radius:2px;background:var(--fleet-accent);pointer-events:none}
      .fleet-panel [data-drop=before]::before{top:-6px}.fleet-panel [data-drop=after]::after{bottom:-6px}
      .fleet-panel .fleet-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      .fleet-panel .fleet-queue-empty{border:1px dashed var(--fleet-line);border-radius:12px;padding:18px 14px;color:var(--fleet-muted);font-size:12px;text-align:center;margin:0}
      .fleet-panel .fleet-queue-feedback{font-size:11px;color:var(--fleet-accent);margin:10px 0 0}
      .fleet-panel .fleet-queue-feedback[data-error=true]{color:#f2a6a6}
      .fleet-panel .fleet-node-feedback{font-size:11px;color:var(--fleet-accent);margin:0 0 10px}
      .fleet-panel .fleet-node-feedback[data-error=true]{color:#f2a6a6}
      .fleet-panel .fleet-recovery{border-top:1px solid var(--fleet-line);padding-top:16px;margin:22px 0 0;color:var(--fleet-muted);font-size:12px}
      .fleet-panel .fleet-recovery>summary{font-weight:550;padding:4px 0}
      .fleet-panel .fleet-recovery>p{line-height:1.65;margin:12px 0}
      .fleet-panel .fleet-recovery>button{margin-top:4px}
      .fleet-panel .fleet-recovery .fleet-backup-feedback{color:var(--fleet-accent);font-size:11px;overflow-wrap:anywhere}
      .fleet-panel .fleet-recovery .fleet-backup-feedback[data-error=true]{color:#f2a6a6}
      .fleet-panel .fleet-backup-feedback code{display:block;margin-top:5px;font:11px/1.6 ui-monospace,monospace}
      .fleet-panel .fleet-nodes-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:22px 0 10px}
      .fleet-panel .fleet-nodes-heading h3{margin:0}
      .fleet-panel .fleet-node-summary{list-style:none;padding:0;margin:0 0 12px;display:grid;gap:12px}
      .fleet-panel .fleet-worker{position:relative;display:grid;grid-template-columns:minmax(0,1fr)44px;align-items:center;gap:12px;padding:14px 12px;border:1px solid var(--fleet-line);border-radius:12px;background:var(--fleet-surface);min-width:0}
      .fleet-panel .fleet-worker[data-active=true]{border-color:rgba(147,223,195,.35)}
      .fleet-panel .fleet-worker-icon{display:grid;place-items:center;width:30px;height:34px;border-radius:8px;background:var(--fleet-surface);color:var(--fleet-muted)}
      .fleet-panel .fleet-worker-icon svg{width:20px;height:20px}
      .fleet-panel .fleet-worker-rail{display:flex;flex-direction:column;align-items:center;gap:5px;align-self:start}
      .fleet-panel .fleet-worker-rail .fleet-drag-handle{min-height:30px;padding:3px 6px}
      .fleet-panel .fleet-worker[data-enabled=true] .fleet-worker-icon{background:rgba(147,223,195,.08);color:var(--fleet-accent)}
      .fleet-panel .fleet-worker-name{display:block;font-size:13px;font-weight:600;overflow-wrap:anywhere}
      .fleet-panel .fleet-worker-hardware{display:block;margin:5px 0 6px;overflow-wrap:anywhere}
      .fleet-panel .fleet-worker-device{display:block;font-size:11px;line-height:1.5}
      .fleet-panel .fleet-worker-device+.fleet-worker-device{margin-top:4px}
      .fleet-panel .fleet-worker-hardware small{display:block;font-size:10px;line-height:1.5;color:var(--fleet-muted)}
      .fleet-panel .fleet-worker-address{display:block;font-size:11px;color:var(--fleet-muted);overflow-wrap:anywhere;margin:3px 0 5px;line-height:1.45}
      .fleet-panel .fleet-worker-status{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--fleet-muted)}
      .fleet-panel .fleet-worker-status:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
      .fleet-panel .fleet-worker[data-enabled=true] .fleet-worker-status{color:var(--fleet-accent)}
      .fleet-panel .fleet-worker-info{display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;align-items:center;min-width:0}
      .fleet-panel .fleet-worker-details{grid-column:1/-1;display:grid;gap:8px;min-width:0}
      .fleet-panel .fleet-worker-details>p{margin:0;font-size:12px;line-height:1.6;color:var(--fleet-muted)}
      .fleet-panel .fleet-worker-details img{margin-top:12px}
      .fleet-panel .fleet-worker-suspension{font-size:11px;color:var(--fleet-muted);margin-top:12px}
      .fleet-panel .fleet-worker-suspension p{margin:0 0 8px}
      .fleet-panel .fleet-worker-error{grid-column:1/-1;margin:0;font-size:11px;line-height:1.5;color:#f2a6a6;overflow-wrap:anywhere}
      .fleet-panel .fleet-worker-toggle{position:relative;width:44px;height:44px;padding:0;border:0;background:transparent!important;border-radius:8px}
      .fleet-panel .fleet-worker-toggle:before{content:"";position:absolute;inset:11px 2px;border-radius:20px;background:rgba(153,167,180,.2);border:1px solid var(--fleet-line);transition:background .12s}
      .fleet-panel .fleet-worker-toggle:after{content:"";position:absolute;top:14px;left:5px;width:16px;height:16px;border-radius:50%;background:var(--fleet-muted);transition:transform .12s,background .12s}
      .fleet-panel .fleet-worker-toggle[aria-checked=true]:before{background:var(--fleet-accent);border-color:var(--fleet-accent)}
      .fleet-panel .fleet-worker-toggle[aria-checked=true]:after{transform:translateX(18px);background:var(--fleet-accent-ink)}
      .fleet-panel .fleet-worker-toggle:hover:not(:disabled):before{filter:brightness(1.15)}
      .fleet-panel small{overflow-wrap:anywhere;display:block}
      .fleet-panel details{margin:12px 0}
      .fleet-panel .fleet-job{padding:10px 12px;border:1px solid var(--fleet-line);border-radius:8px;background:var(--fleet-surface);min-width:0}
      .fleet-panel .fleet-job[data-active=true]{border-color:transparent;border-left:2px solid var(--fleet-accent);background:rgba(147,223,195,.055)}
      .fleet-panel .fleet-job-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}
      .fleet-panel .fleet-job-heading .fleet-job-state{margin:0;min-width:0}
      .fleet-panel .fleet-job-cancel{flex:none;font-size:10px;padding:4px 7px;min-height:28px}
      .fleet-panel .fleet-job-batch{display:block;font-size:12px;font-weight:550;overflow-wrap:anywhere;line-height:1.5}
      .fleet-panel .fleet-job-batch-time{font-size:10px;color:var(--fleet-muted);line-height:1.5;margin-top:2px}
      .fleet-panel .fleet-step-progress{margin-top:10px;color:var(--fleet-muted);font-size:10px}
      .fleet-panel .fleet-job-state{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--fleet-muted);margin-bottom:5px}
      .fleet-panel .fleet-job-state:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
      .fleet-panel .fleet-job[data-active=true] .fleet-job-state{color:var(--fleet-accent)}
      .fleet-panel .fleet-job-recovery{font-size:11px;line-height:1.6;margin-top:8px;overflow-wrap:anywhere}
      .fleet-panel .fleet-job-recovery p{margin:0 0 8px;color:#f2a6a6}
      .fleet-panel .fleet-job-recovery button{font-size:11px;min-height:30px}
      .fleet-panel .fleet-pagination{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px}
      @media(prefers-reduced-motion:reduce){.fleet-panel button,.fleet-panel .fleet-worker-toggle:before,.fleet-panel .fleet-worker-toggle:after{transition:none}}
    `);
    this.root.append(style);
  }

  button(label, action) {
    const button = element("button", label, { type: "button" });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await action(); }
      catch (error) { this.message(error.message, true); }
      finally { button.disabled = false; if (this.editing) this.updateSetupActions(); }
    });
    return button;
  }

  draftKey() { return `comfyui-fleet:setup:${this.state.instance_id}`; }

  persistDraft() {
    if (!this.editing || !this.state.instance_id) return;
    try {
      localStorage.setItem(this.draftKey(), JSON.stringify({ workers: this.drafts,
        address: this.addressInput.value, name: this.nameInput.value, nameEdited: this.nameEdited, formOpen: this.formOpen }));
    } catch { /* Setup remains usable when browser storage is unavailable. */ }
  }

  forgetDraft() {
    try { localStorage.removeItem(this.draftKey()); } catch { /* Storage may be unavailable. */ }
    this.drafts = [];
    this.draftHardware.clear();
    this.nodeList.replaceChildren();
    this.addressInput.value = ""; this.nameInput.value = "";
    this.nameEdited = false;
  }

  restoreDraft() {
    if (!this.state.instance_id) return null;
    try {
      const draft = JSON.parse(localStorage.getItem(this.draftKey()));
      if (!Array.isArray(draft?.workers) || draft.workers.length > 64 ||
          draft.workers.some(worker => typeof worker.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(worker.id) ||
            typeof worker.url !== "string" || typeof worker.enabled !== "boolean") ||
          typeof draft.address !== "string" || typeof draft.name !== "string") return null;
      return draft;
    } catch { return null; }
  }

  beginSetup(workers, draft = null) {
    this.cancelReordering();
    this.nodeEdit++;
    this.busy = null;
    this.editing = true;
    this.drafts = (draft?.workers ?? workers).map(worker => ({ ...worker, enabled: Boolean(worker.enabled) }));
    this.addressInput.value = draft?.address ?? "";
    this.nameInput.value = draft?.name ?? "";
    this.nameEdited = typeof draft?.nameEdited === "boolean" ? draft.nameEdited : Boolean(draft?.name);
    this.formOpen = draft?.formOpen !== false || !this.drafts.length;
    this.resetAddressCheck();
    if (this.addressInput.value.trim()) {
      try { this.readAddress(); }
      catch (error) { this.setAddressError(error.message); }
    }
    this.setupError.hidden = true;
    this.renderDrafts();
    this.updateView();
    this.persistDraft();
  }

  updateView() {
    this.root.dataset.setup = String(this.editing);
    this.setup.hidden = !this.editing;
    this.dashboard.hidden = this.editing || !this.initialized;
    this.modeBadge.hidden = !this.editing;
    if (this.editing) this.cancelFeedback.hidden = true;
    this.modeBadge.textContent = this.state?.workers.length ? "Node setup" : "Setup";
    this.status.hidden = !this.status.textContent || !this.versionNotice.hidden || (this.editing && !this.statusError);
    if (this.editing) this.updateSetupActions();
  }

  updateSetupActions() {
    const count = this.drafts.length;
    const existing = this.state.workers.length > 0;
    const changed = Boolean(this.addressInput.value.trim() || this.nameInput.value.trim()) ||
      count !== this.state.workers.length || this.drafts.some((worker, index) => {
        const saved = this.state.workers[index];
        return worker.id !== saved.id || worker.url !== saved.url || worker.enabled !== Boolean(saved.enabled);
      });
    this.nodeForm.hidden = !this.formOpen;
    this.addAnotherButton.hidden = this.formOpen || count >= 64;
    this.addAnotherButton.disabled = Boolean(this.busy);
    this.cancelNodeButton.hidden = !count && !this.addressInput.value && !this.nameInput.value;
    this.cancelNodeButton.textContent = count ? "Cancel" : "Clear fields";
    this.cancelNodeButton.disabled = this.busy === "saving";
    this.setupTitle.textContent = count ? "Build your fleet" : "Add your first node";
    this.setupIntro.textContent = count ? "Add another node, or choose Done when your fleet is ready. You can change this list later." :
      "Connect a running ComfyUI instance to start sharing your workflow jobs. One node is enough to get started.";
    this.listTitle.hidden = !count;
    this.listTitle.textContent = `${count} node${count === 1 ? "" : "s"} in your list`;
    this.formLegend.textContent = count ? "Add another node" : "Node details";
    this.formFields.disabled = Boolean(this.busy);
    this.addButton.disabled = Boolean(this.busy) || !this.addressInput.value.trim() || count >= 64 || !this.state.ready;
    this.addButton.className = `${count ? "fleet-secondary" : "fleet-primary"} fleet-add-node`;
    this.addButton.textContent = this.busy === "checking" ? "Checking connection…" : count >= 64 ? "64-node limit reached" : "Add node";
    this.doneButton.disabled = Boolean(this.busy) || (!count && !existing) || !this.state.ready;
    this.doneButton.textContent = this.busy === "saving" ? "Saving…" : "Done";
    this.backButton.hidden = !existing || !changed;
    this.backButton.disabled = Boolean(this.busy);
    this.footerHint.hidden = existing && !changed;
    this.footerHint.textContent = count ? "Your changes take effect when you click Done." : existing ?
      "Removing every node returns Fleet to setup." : "Add a node to continue. You can add more later.";
    for (const control of this.nodeList.querySelectorAll("button,input")) control.disabled = Boolean(this.busy);
  }

  renderDrafts() {
    if (!this.drafts.length) this.formOpen = true;
    this.draftHardware.clear();
    this.nodeList.replaceChildren(...this.drafts.map(worker => {
      const card = element("div", null, { className: "fleet-node-card" });
      const row = element("div", null, { className: "fleet-node-heading" });
      const copy = element("div", null, { className: "fleet-node-copy" });
      const hardware = element("span", null, { className: "fleet-worker-hardware" });
      this.draftHardware.set(worker.id, hardware);
      copy.append(element("strong", nodeLabel(worker.id)), hardware,
        element("span", worker.url, { className: "fleet-node-address" }));
      const remove = this.button("Remove", async () => {
        if (!await this.confirmAction(`Remove “${nodeLabel(worker.id)}”?`,
          "This removes the node from your setup list. Click Done to save the change. No jobs will be cancelled.",
          "Remove node", "Keep node")) return;
        this.drafts = this.drafts.filter(item => item !== worker);
        this.setupError.hidden = true;
        this.renderDrafts(); this.persistDraft();
      });
      remove.className = "fleet-danger fleet-remove";
      remove.setAttribute("aria-label", `Remove ${nodeLabel(worker.id)}`);
      row.append(copy, remove); card.append(row);
      return card;
    }));
    this.renderDraftHardware();
    this.updateSetupActions();
  }

  renderDraftHardware() {
    for (const worker of this.drafts) {
      const live = this.state.hardware?.[worker.id];
      const info = live?.url === worker.url ? live : worker.hardware?.url === worker.url ? worker.hardware :
        worker.checked ? { available: false } : null;
      renderHardware(this.draftHardware.get(worker.id), info);
    }
  }

  setupFailure(error) {
    this.setupError.replaceChildren(element("strong", "Changes haven’t been saved"), element("p", error.message));
    this.setupError.hidden = false;
    this.setupError.focus();
  }

  readAddress() {
    const url = nodeAddress(this.addressInput.value);
    if (this.drafts.some(worker => worker.url === url)) throw new Error("That address is already in your list.");
    return url;
  }

  setAddressIcon(state = "", detail = "") {
    this.addressIcon.dataset.state = state;
    this.addressIcon.textContent = state === "valid" ? "✓" : state === "invalid" ? "×" : "";
    this.addressIcon.title = state === "checking" ? "Checking connection…" : state === "valid" ? "Connection verified" : detail;
    this.addressIcon.hidden = !state;
    this.addressInput.setAttribute("aria-busy", String(state === "checking"));
  }

  setAddressError(message) {
    this.addressInput.setAttribute("aria-invalid", String(Boolean(message)));
    this.addressError.textContent = message;
    this.addressError.hidden = !message;
    this.addressHint.hidden = Boolean(message);
    this.addressHint.textContent = "Use the node's private IP address and port.";
    this.setAddressIcon(message ? "invalid" : "", message);
    this.addressHardwareBox.hidden = true;
    // Referenced hidden content can still be read through aria-describedby.
    this.addressHardware.replaceChildren();
    this.addressHardware.hardwareSignature = null;
  }

  resetAddressCheck() {
    clearTimeout(this.addressTimer);
    this.addressCheck = null;
    this.setAddressError("");
  }

  reportAddressError(message) {
    // Typing can discover success, but failures wait for blur or an explicit Add.
    this.setAddressError(this.busy === "checking" || document.activeElement !== this.addressInput ? message : "");
  }

  cancelNode() {
    if (this.busy === "saving") return;
    this.nodeEdit++;
    this.busy = null;
    this.addressInput.value = ""; this.nameInput.value = "";
    this.nameEdited = false;
    this.resetAddressCheck();
    this.formOpen = !this.drafts.length;
    this.setupError.hidden = true;
    this.updateSetupActions(); this.persistDraft();
    (this.drafts.length ? this.doneButton : this.addressInput).focus();
  }

  async verifyAddress({ retry = false } = {}) {
    clearTimeout(this.addressTimer);
    if (!this.addressInput.value.trim()) { this.resetAddressCheck(); return null; }
    let url;
    try { url = this.readAddress(); }
    catch (error) { this.resetAddressCheck(); this.reportAddressError(error.message); return null; }
    if (this.addressCheck?.url === url) {
      if (this.addressCheck.status === "valid") return this.addressCheck.result;
      if (this.addressCheck.status === "checking") return this.addressCheck.promise;
      if (!retry) { this.reportAddressError(this.addressCheck.error); return null; }
    }
    const check = { url, status: "checking" };
    this.addressCheck = check;
    this.setAddressError("");
    this.setAddressIcon("checking");
    check.promise = (async () => {
      try {
        const result = await this.actions.checkWorker(url);
        // Editing or cancelling makes this response obsolete, even if the URL is later reused.
        if (this.addressCheck !== check) return null;
        if (this.drafts.some(worker => worker.url === result.url)) throw new Error("That address is already in your list.");
        check.status = "valid"; check.result = result;
        this.setAddressError("");
        this.setAddressIcon("valid");
        this.addressHint.hidden = true;
        renderHardware(this.addressHardware, result.hardware ?? { available: false });
        this.addressHardwareBox.hidden = false;
        if (!this.nameEdited) this.nameInput.value = suggestedNodeName(result.hardware, this.drafts);
        this.persistDraft();
        return result;
      } catch (error) {
        if (this.addressCheck !== check) return null;
        check.status = "invalid"; check.error = error.message;
        this.reportAddressError(check.error);
        return null;
      }
    })();
    return check.promise;
  }

  async addNode() {
    if (this.busy) return;
    const edit = this.nodeEdit;
    let added = false;
    this.setupError.hidden = true;
    try {
      if (this.drafts.length >= 64) throw new Error("Fleet supports up to 64 nodes in one setup.");
      this.busy = "checking"; this.updateSetupActions();
      const checked = await this.verifyAddress({ retry: true });
      if (edit !== this.nodeEdit) return;
      if (!checked) { this.addressInput.focus(); return; }
      const id = nodeName(this.nameInput.value, this.drafts);
      this.drafts.push({ id, url: checked.url, enabled: true, checked: true,
        hardware: checked.hardware ?? { url: checked.url, available: false } });
      added = true;
      this.addressInput.value = ""; this.nameInput.value = "";
      this.nameEdited = false;
      this.resetAddressCheck();
      this.renderDrafts(); this.persistDraft();
    } catch (error) { this.setupFailure(error); }
    finally {
      if (edit === this.nodeEdit) {
        this.busy = null; this.updateSetupActions();
        if (added) this.addressInput.focus();
      }
    }
  }

  async finishSetup() {
    if (this.busy) return;
    this.setupError.hidden = true;
    try {
      if (this.addressInput.value.trim() || this.nameInput.value.trim()) {
        throw new Error("Add this node or choose Cancel before clicking Done.");
      }
      if (!this.drafts.length && !this.state.workers.length) throw new Error("Add at least one node to finish setup.");
      this.busy = "saving"; this.updateSetupActions();
      const workers = this.drafts.map(({ id, url, enabled }) => ({ id, url, enabled }));
      await this.actions.configure(workers);
      this.resetAddressCheck();
      this.forgetDraft(); this.editing = false;
      this.message("");
      this.updateView();
      if (!workers.length) this.beginSetup([]);
    } catch (error) { this.setupFailure(error); }
    finally { this.busy = null; if (this.editing) this.updateSetupActions(); }
  }

  message(text, error = false) {
    const issue = error && versionIssue(text);
    this.statusError = error;
    this.versionNotice.hidden = !issue;
    // Polling repeats startup errors. Preserve focus and expanded details until the error changes.
    if (issue && this.versionMessage !== text) {
      const icon = element("span", null, { className: "fleet-version-icon" });
      icon.setAttribute("aria-hidden", "true");
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      const path = document.createElementNS(ns, "path");
      for (const [name, value] of Object.entries({ d: "M12 3 2 21h20L12 3Zm0 6v5m0 3v.5", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" })) path.setAttribute(name, value);
      svg.append(path); icon.append(svg);
      const requirements = element("div", null, { className: "fleet-version-requirements" });
      const list = element("dl");
      for (const [name, version] of issue.versions) {
        const row = element("div", null, { className: "fleet-version-row" });
        row.append(element("dt", name), element("dd", version));
        list.append(row);
      }
      requirements.append(element("p", issue.label, { className: "fleet-version-label" }), list);
      if (issue.installed) requirements.append(element("p", issue.installed, { className: "fleet-version-installed" }));
      const details = element("details", null, { className: "fleet-version-details" });
      details.append(element("summary", "Technical details"), element("pre", text));
      this.versionNotice.replaceChildren(icon,
        element("p", "Compatibility check", { className: "fleet-version-label" }),
        element("h3", "Version update needed"),
        element("p", issue.description, { className: "fleet-version-description" }),
        requirements, element("p", issue.next, { className: "fleet-version-next" }));
      if (this.actions.retry) {
        const retry = this.button("Check again", () => this.actions.retry());
        retry.className = "fleet-primary fleet-wide";
        this.versionNotice.append(retry);
      }
      this.versionNotice.append(details);
    }
    this.versionMessage = issue ? text : null;
    this.status.textContent = issue ? "" : text;
    this.status.style.color = error ? "#f2a6a6" : "";
    this.status.hidden = !text || Boolean(issue) || (this.editing && !error);
  }

  notify(text) {
    this.dismissNotification();
    // Older hosts can lack the optional toast interface. Keep their feedback
    // temporary too, separately from errors and in-progress action messages.
    try { if (this.actions.notify?.(text)) return; } catch { /* Use the inline fallback. */ }
    this.notificationText.textContent = text;
    this.notification.hidden = false;
    this.notificationTimer = setTimeout(() => this.dismissNotification(), 5000);
  }

  dismissNotification() {
    clearTimeout(this.notificationTimer);
    this.notification.hidden = true;
    this.notificationText.textContent = "";
  }

  confirmAction(title, description, action, keepLabel = "Keep jobs") {
    if (this.confirmation) return Promise.resolve(false);
    const dialog = element("dialog", null, { className: "fleet-confirm" });
    dialog.setAttribute("aria-labelledby", "fleet-confirm-title");
    dialog.setAttribute("aria-describedby", "fleet-confirm-description");
    const keep = element("button", keepLabel, { type: "button", autofocus: true });
    const confirm = element("button", action, { type: "button", className: "fleet-danger" });
    const footer = element("footer");
    footer.append(keep, confirm);
    dialog.append(element("h3", title, { id: "fleet-confirm-title" }),
      element("p", description, { id: "fleet-confirm-description" }), footer);
    this.root.append(dialog);
    return new Promise(resolve => {
      let settled = false;
      const finish = accepted => {
        if (settled) return;
        settled = true; this.confirmation = null;
        dialog.close(); dialog.remove(); resolve(accepted);
      };
      this.confirmation = { cancel: () => finish(false) };
      keep.addEventListener("click", () => finish(false));
      confirm.addEventListener("click", () => finish(true));
      dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
      dialog.addEventListener("close", () => finish(false));
      dialog.showModal(); keep.focus();
    });
  }

  renameInline(row) {
    if (row.renaming || !this.state.ready) return;
    row.renaming = true;
    const input = element("input", null, { type: "text", value: row.batch.name, maxLength: 200 });
    input.setAttribute("aria-label", "Batch name");
    row.name.replaceChildren(input);
    let busy = false, closed = false;
    const finish = () => {
      closed = true; row.renaming = false;
      row.name.textContent = row.batch.name;
    };
    const save = async () => {
      if (busy || closed) return;
      if (!input.value.trim()) {
        input.setAttribute("aria-invalid", "true");
        this.queueMessage("Batch name cannot be empty.", true);
        return;
      }
      if (input.value.trim() === row.batch.name) { finish(); return; }
      busy = true; input.disabled = true;
      try {
        await this.actions.renameBatch(row.batch.id, input.value.trim());
        finish(); this.queueMessage("");
      } catch (error) {
        this.queueMessage(`Could not rename batch. ${error.message}`, true);
      } finally { busy = false; input.disabled = false; }
    };
    input.addEventListener("blur", save);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); save(); }
      if (event.key === "Escape" && !busy) { event.preventDefault(); finish(); this.queueMessage(""); }
    });
    input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
    input.focus(); input.select();
  }

  async saveBackup() {
    this.backupFeedback.hidden = false;
    this.backupFeedback.dataset.error = "false";
    this.backupFeedback.setAttribute("role", "status");
    this.backupFeedback.textContent = "Saving a backup…";
    try {
      const result = await this.actions.backup();
      this.backupFeedback.replaceChildren("Node backup saved on the ComfyUI server.",
        element("code", `fleet/backups/${result.filename}`));
    } catch (error) {
      this.backupFeedback.dataset.error = "true";
      this.backupFeedback.setAttribute("role", "alert");
      this.backupFeedback.textContent = `Backup could not be saved. ${error.message}`;
    }
  }

  pagination(page, pages, change) {
    const row = element("div", null, { className: "fleet-pagination" });
    const previous = this.button("Previous", () => change(page - 1));
    const next = this.button("Next", () => change(page + 1));
    previous.disabled = page === 0;
    next.disabled = page + 1 >= pages;
    row.append(previous, element("span", `Page ${page + 1} of ${pages}`), next);
    return row;
  }

  jobRow(job, batch) {
    const article = element("article", null, { className: "fleet-job" });
    article.dataset.jobId = job.id;
    article.dataset.batchId = batch.id;
    article.dataset.active = String(Boolean(job.occupied));
    const stopping = job.cancel_requested || this.cancellingJobs.has(job.id) || (job.occupied && this.cancellingActive);
    const heading = element("div", null, { className: "fleet-job-heading" });
    heading.append(element("span", jobStatus({ ...job, cancel_requested: stopping }), { className: "fleet-job-state" }));
    if (job.occupied && !terminal.has(job.state)) {
      const cancel = element("button", stopping ? "Cancelling…" : "Cancel job",
        { type: "button", className: "fleet-danger fleet-job-cancel", disabled: Boolean(stopping) || !this.state.ready });
      cancel.title = "Cancel only this job. Other jobs and the queue will continue.";
      cancel.addEventListener("click", () => this.cancelJob(job, batch));
      heading.append(cancel);
    }
    article.append(heading,
      element("strong", batch.name, { className: "fleet-job-batch" }),
      element("small", batchTime(batch), { className: "fleet-job-batch-time" }));
    const progress = element("div", null, { className: "fleet-step-progress", hidden: true });
    const bar = element("progress", null, { className: "fleet-progress", max: 100, value: 0 });
    bar.setAttribute("aria-label", "Current step progress");
    progress.append(element("span"), bar);
    article.append(progress);
    const recovery = element("div", null, { className: "fleet-job-recovery" });
    if (this.jobCancellationErrors.has(job.id)) {
      const error = element("p", this.jobCancellationErrors.get(job.id));
      error.setAttribute("role", "alert"); recovery.append(error);
    }
    if (job.error && job.state !== "unknown") recovery.append(element("p", job.error));
    if (job.state === "unknown" && job.occupied) {
      recovery.append(element("p", "Fleet is checking this job. If the node no longer has it, it will be dropped and queued work will continue."));
    }
    if (job.collection_state === "error") {
      recovery.append(element("p", "Retry saving the results without executing the workflow again."),
        this.button("Retry saving results", () => this.actions.jobAction(job.id, "collect")));
    }
    if (recovery.childElementCount) article.append(recovery);
    return article;
  }

  renderJobProgress() {
    const jobs = new Map(this.state.jobs.map(job => [job.id, job]));
    for (const article of this.workers.querySelectorAll(".fleet-job")) {
      const job = jobs.get(article.dataset.jobId);
      const value = job ? stepProgress(job, this.state.progress?.[job.id]) : null;
      const progress = article.querySelector(".fleet-step-progress");
      progress.hidden = value == null;
      if (value != null) {
        progress.querySelector("span").textContent = `Current step · ${value}%`;
        progress.querySelector("progress").value = value;
      }
    }
  }

  get cancellingQueuedJobs() { return this.cancellingQueue || this.cancellingBatches.size > 0; }

  async cancelJob(job, batch) {
    if (this.cancellingActive || this.cancellingJobs.has(job.id) || !this.state.ready || job.cancel_requested) return;
    const label = `“${batch.name}” on ${nodeLabel(job.worker_id)}`;
    if (!await this.confirmAction(`Cancel ${label}?`,
      "Only this job will be cancelled. Other active jobs and queued jobs will continue. If this node is enabled, it can take another queued job afterward.",
      "Cancel job")) return;
    // The node may have started a different job while the confirmation was open.
    const current = this.state.jobs.find(item => item.id === job.id);
    if (!current?.occupied || terminal.has(current.state)) {
      this.notify("This job is no longer active. No other jobs were cancelled.");
      return;
    }
    if (current.cancel_requested) return;
    this.cancellingJobs.add(job.id);
    this.jobCancellationErrors.delete(job.id);
    this.renderWorkers();
    try {
      await this.actions.cancelJob(job.id);
      this.notify(`Cancellation requested for ${label}.`);
    } catch (error) {
      this.jobCancellationErrors.set(job.id, `Could not cancel this job. ${error.message}`);
    } finally {
      this.cancellingJobs.delete(job.id);
      this.renderWorkers();
    }
  }

  renderCancellation() {
    // Legacy unknown jobs whose slots were released are no longer active.
    const active = this.state.jobs.filter(job => !terminal.has(job.state) && job.occupied);
    const remaining = active.filter(job => !job.cancel_requested);
    this.cancelActiveButton.disabled = this.cancellingActive || this.cancellingJobs.size > 0 || this.cancellingQueuedJobs || this.queueOrder.busy || this.workerOrder.busy || !remaining.length || !this.state.ready;
    this.cancelActiveButton.textContent = this.cancellingActive || (active.length && !remaining.length) ? "Stopping…" : "Cancel active jobs";
  }

  async cancelActive() {
    if (this.cancellingActive || this.cancellingJobs.size || this.cancellingQueuedJobs || this.queueOrder.busy || this.workerOrder.busy || !this.state.ready ||
        !this.state.jobs.some(job => !terminal.has(job.state) && job.occupied && !job.cancel_requested)) return;
    if (!await this.confirmAction("Cancel active jobs?",
      "Cancellation will be requested for every job currently assigned to a node. Queued jobs will remain and can start as nodes become free. Cancel queued jobs first if you want all work to stop.",
      "Cancel active jobs")) return;
    this.cancellingActive = true;
    this.cancelFeedback.hidden = true;
    this.cancelFeedback.textContent = "";
    this.queueFeedback.hidden = true;
    this.renderQueue(); this.renderWorkers();
    try {
      const result = await this.actions.cancelActive();
      this.notify(result.cancelled ?
        `Cancellation requested for ${result.cancelled} active job${result.cancelled === 1 ? "" : "s"}.` : "No active jobs remained to cancel.");
    } catch (error) {
      this.cancelFeedback.dataset.error = "true";
      this.cancelFeedback.textContent = `Could not cancel active jobs. ${error.message}`;
      this.cancelFeedback.hidden = this.editing;
    } finally {
      this.cancellingActive = false;
      this.renderQueue(); this.renderWorkers();
    }
  }

  async cancelQueued(batch = null) {
    if (this.cancellingActive || this.cancellingQueue || (batch ? this.cancellingBatches.has(batch.id) : this.cancellingBatches.size) ||
        this.queueOrder.busy || this.workerOrder.busy || !this.state.ready || !queuedJobs(this.state.jobs).length) return;
    if (!await this.confirmAction(batch ? `Cancel queued jobs in “${batch.name}”?` : "Cancel all queued jobs?",
      batch ? "Only jobs still waiting in this batch will be cancelled. Assigned jobs will keep running. Other batches will not be affected." :
        "Jobs waiting across every batch will be cancelled. Assigned jobs will keep running. You can still add new jobs afterward.",
      batch ? "Cancel batch" : "Cancel queued jobs")) return;
    if (batch) this.cancellingBatches.add(batch.id);
    else this.cancellingQueue = true;
    this.queueMessage("");
    this.renderQueue();
    const scope = batch ? ` in “${batch.name}”` : "";
    try {
      const result = await this.actions.cancelQueued(batch?.id);
      this.notify(result.cancelled ?
        `Cancelled ${result.cancelled} queued job${result.cancelled === 1 ? "" : "s"}${scope}.${batch ? " Active jobs keep running." : ""}` :
        `No queued jobs remained to cancel${scope}.`);
    } catch (error) {
      this.queueMessage(`Could not cancel queued jobs${scope}. ${error.message}`, true);
    } finally {
      if (batch) this.cancellingBatches.delete(batch.id);
      else this.cancellingQueue = false;
      this.renderQueue();
    }
  }

  queueMessage(text, error = false) {
    this.queueFeedback.textContent = text;
    this.queueFeedback.dataset.error = String(error);
    this.queueFeedback.hidden = !text;
  }

  cancelReordering() {
    this.queueOrder.finish(false);
    this.workerOrder.finish(false);
  }

  createBatchRow(batch) {
    const root = element("li", null, { className: "fleet-batch" });
    root.dataset.batchId = batch.id;
    const handle = this.queueOrder.handle(batch.id, batch.name);
    const copy = element("div");
    const name = element("strong"), time = element("small"), count = element("p", null, { className: "fleet-batch-count" });
    const progress = element("progress", null, { className: "fleet-progress" });
    const status = element("small");
    const cancel = this.button("Cancel batch", () => this.cancelQueued(batch));
    cancel.className = "fleet-danger";
    cancel.title = "Cancel queued jobs in this batch. Active jobs keep running.";
    const footer = element("div", null, { className: "fleet-batch-footer" });
    footer.append(status, cancel);
    const heading = element("div", null, { className: "fleet-batch-heading" });
    const menu = element("details", null, { className: "fleet-batch-menu" });
    const toggle = element("summary", "⋯");
    toggle.setAttribute("aria-label", `Batch actions for ${batch.name}`);
    const rename = this.button("Edit batch", async () => {
      menu.open = false;
      try { await this.actions.editBatchDetails(batch.id); }
      catch (error) { this.queueMessage(error.message, true); }
    });
    const edit = this.button("Edit workflow", async () => {
      menu.open = false;
      try { await this.actions.editBatch(batch.id); }
      catch (error) { this.queueMessage(error.message, true); }
    });
    edit.className = "fleet-edit-workflow";
    menu.addEventListener("keydown", event => { if (event.key === "Escape") { menu.open = false; toggle.focus(); } });
    const discard = this.button("Discard changes and resume", async () => {
      menu.open = false;
      if (!await this.confirmAction("Discard batch changes?", "The batch will keep its saved name, size and workflow, and queue scheduling will resume.", "Discard changes")) return;
      try { await this.actions.discardBatchEdit(batch.id); }
      catch (error) { this.queueMessage(error.message, true); }
    });
    discard.className = "fleet-discard-edit";
    const actions = element("div", null, { className: "fleet-batch-actions" });
    actions.append(rename, edit, discard);
    menu.append(toggle, actions);
    heading.append(name, menu);
    copy.append(heading, time, count, progress, footer);
    root.append(handle, copy);
    const row = { batch, root, handle, name, time, count, progress, status, cancel, toggle, rename, edit, discard };
    name.title = "Double-click to rename";
    name.addEventListener("dblclick", () => this.renameInline(row));
    return row;
  }

  renderQueue() {
    this.renderCancellation();
    const batches = queuedBatches(this.state.jobs, this.state.batch_names, this.state.batch_counts);
    const waiting = batches.reduce((sum, batch) => sum + batch.queued, 0);
    this.queueCount.textContent = `${batches.length} batch${batches.length === 1 ? "" : "es"}`;
    const busy = Boolean(this.state.edit) || this.queueOrder.saving || this.workerOrder.busy || this.cancellingActive || this.cancellingQueuedJobs;
    const batchBusy = id => this.state.edit?.batch_id === id || this.queueOrder.busy || this.workerOrder.busy || this.cancellingActive || this.cancellingQueue || this.cancellingBatches.has(id) || !this.state.ready;
    this.cancelQueueButton.disabled = busy || Boolean(this.queueOrder.drag) || !waiting || !this.state.ready;
    this.cancelQueueButton.textContent = this.cancellingQueue ? "Cancelling…" : "Cancel queued jobs";
    this.queueHint.textContent = this.state.edit ? "A batch is being edited. Earlier work can continue; this batch and everything after it are held. Queue order is locked." : this.state.paused ? "Scheduling is stopped. Complete the recovery steps before starting new work." :
      batches.length ? "Drag batches to change what goes next. Active jobs keep running." : "Use ComfyUI’s Run button to add work.";
    this.queueList.setAttribute("aria-busy", String(this.queueOrder.saving || this.cancellingQueue));
    for (const [id, row] of this.queueRows) row.cancel.disabled = batchBusy(id);
    if (this.queueOrder.saving) for (const row of this.queueRows.values()) row.handle.disabled = true;
    // Keep the pickup target and insertion marker stable while live polling continues.
    if (this.queueOrder.drag || this.queueOrder.saving) return;
    this.queueList.hidden = !batches.length;
    this.queueEmpty.hidden = Boolean(batches.length);
    for (const [id, row] of this.queueRows) {
      if (!batches.some(batch => batch.id === id)) { row.root.remove(); this.queueRows.delete(id); }
    }
    batches.forEach((batch, index) => {
      let row = this.queueRows.get(batch.id);
      if (!row) { row = this.createBatchRow(batch); this.queueRows.set(batch.id, row); }
      Object.assign(row.batch, batch);
      if (this.queueList.children[index] !== row.root) this.queueList.insertBefore(row.root, this.queueList.children[index] ?? null);
      if (!row.renaming) row.name.textContent = batch.name;
      row.toggle.setAttribute("aria-label", `Batch actions for ${batch.name}`);
      const held = this.state.edit?.batch_id === batch.id;
      const detailsHeld = held && this.state.edit.kind === "details";
      row.rename.textContent = detailsHeld ? "Resume editing" : "Edit batch";
      row.rename.disabled = !this.state.ready || Boolean(this.state.edit && !detailsHeld) || this.cancellingQueue || this.cancellingBatches.has(batch.id);
      row.discard.hidden = this.state.edit?.batch_id !== batch.id;
      row.edit.textContent = held && !detailsHeld ? "Resume editing" : "Edit workflow";
      row.edit.disabled = !this.state.ready || Boolean(this.state.edit && (!held || detailsHeld));
      row.handle.setAttribute("aria-label", `Reorder ${batch.name}`);
      row.handle.disabled = busy || !this.state.ready || batches.length < 2;
      row.cancel.disabled = batchBusy(batch.id);
      row.cancel.textContent = this.cancellingBatches.has(batch.id) ? "Cancelling…" : "Cancel batch";
      row.root.setAttribute("aria-busy", String(this.cancellingBatches.has(batch.id)));
      row.time.textContent = batchTime(batch);
      renderBatchProgress(row, batch);
      row.status.textContent = [batch.active && `${batch.active} active`, `${batch.queued} queued`,
        batch.failed && `${batch.failed} failed`, batch.cancelled && `${batch.cancelled} cancelled`,
        batch.review && `${batch.review} checking`].filter(Boolean).join(" · ");
    });
  }

  renderWorkerActivity(row, worker, jobs, suspensions, batches) {
    row.body.hidden = !jobs.length && !suspensions.length;
    if (row.body.hidden) {
      row.body.replaceChildren();
      row.signature = null;
      this.workerPages.delete(worker.id);
      return;
    }
    const labels = jobs.map(job => { const batch = batches.get(job.batch_id); return [batch.name, batch.created]; });
    const cancellations = jobs.map(job => [this.cancellingJobs.has(job.id), this.jobCancellationErrors.get(job.id)]);
    const signature = JSON.stringify([jobs, labels, suspensions, worker.enabled, this.selected, this.cancellingActive, cancellations, this.workerPages.get(worker.id), this.state.ready]);
    if (signature === row.signature) return;
    row.signature = signature;
    row.body.replaceChildren();
    if (jobs.length) {
      const ordered = [...jobs].sort((a, b) => Number(Boolean(b.occupied)) - Number(Boolean(a.occupied)));
      const pages = Math.ceil(ordered.length / pageSize);
      const page = Math.min(this.workerPages.get(worker.id) ?? 0, pages - 1);
      row.body.append(...ordered.slice(page * pageSize, (page + 1) * pageSize).map(job => this.jobRow(job, batches.get(job.batch_id))));
      if (pages > 1) row.body.append(this.pagination(page, pages, value => { this.workerPages.set(worker.id, value); this.renderWorkers(); }));
    }
    for (const suspension of suspensions) {
      const notice = element("div", null, { className: "fleet-worker-suspension" });
      notice.append(element("p", "A failed job stopped this node accepting more work from a batch."),
        this.button("Re-enable batch", () => this.actions.reenable(suspension.batch_id, worker.id)));
      row.body.append(notice);
    }
  }

  async toggleWorker(id) {
    // Configuration saves the complete list. Allow only one save at a time.
    if (this.workerSaving || this.workerOrder.busy || this.queueOrder.busy || !this.state?.ready) return;
    const worker = this.state.workers.find(item => item.id === id);
    if (!worker) return;
    const enabled = !worker.enabled;
    this.workerSaving = id;
    this.workerError = null;
    this.renderWorkers();
    try {
      const saved = await this.actions.configure(this.state.workers.map(item => ({
        id: item.id, url: item.url, enabled: item.id === id ? enabled : Boolean(item.enabled),
      })));
      if (Array.isArray(saved)) this.state.workers = saved;
      this.notify(`${nodeLabel(id)} ${enabled ? "enabled for new jobs." : "disabled. Assigned jobs keep running."}`);
    } catch (error) {
      this.workerError = { id, message: `Could not save this change. ${error.message}` };
    } finally {
      this.workerSaving = null;
      this.renderWorkers();
    }
  }

  renderWorkers() {
    this.renderCancellation();
    for (const id of this.jobCancellationErrors.keys()) {
      if (!this.state.jobs.some(job => job.id === id && job.occupied && !terminal.has(job.state))) this.jobCancellationErrors.delete(id);
    }
    const workers = this.state.workers;
    const batches = batchSummaries(this.state.jobs, this.state.batch_names, this.state.batch_counts);
    this.manageNodesButton.disabled = Boolean(this.workerSaving) || this.workerOrder.busy || this.queueOrder.busy;
    this.workers.setAttribute("aria-busy", String(this.workerOrder.saving));
    const controlsBusy = Boolean(this.workerSaving) || this.workerOrder.busy || this.queueOrder.busy || !this.state.ready;
    for (const [id, row] of this.workerRows) {
      row.toggle.disabled = controlsBusy;
      row.handle.disabled = this.workerOrder.saving || (this.workerOrder.drag && this.workerOrder.drag.id !== id) || this.workerOrder.isDisabled() || workers.length < 2;
    }
    // Preserve the picked-up card and its dimensions while snapshots keep arriving.
    if (this.workerOrder.busy) return;
    for (const [id, row] of this.workerRows) {
      if (!workers.some(worker => worker.id === id)) { row.root.remove(); this.workerRows.delete(id); }
    }
    workers.forEach((worker, index) => {
      let row = this.workerRows.get(worker.id);
      if (!row) {
        const root = element("li", null, { className: "fleet-worker" });
        root.dataset.workerId = worker.id;
        const icon = element("span", null, { className: "fleet-worker-icon" });
        icon.setAttribute("aria-hidden", "true");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        for (const [name, value] of Object.entries({ d: "M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" })) path.setAttribute(name, value);
        svg.append(path); icon.append(svg);
        const handle = this.workerOrder.handle(worker.id, nodeLabel(worker.id));
        const rail = element("span", null, { className: "fleet-worker-rail" });
        rail.append(icon, handle);
        const copy = element("span");
        const name = element("strong", nodeLabel(worker.id), { className: "fleet-worker-name" });
        const hardware = element("span", null, { className: "fleet-worker-hardware", id: `fleet-node-hardware-${worker.id}` });
        const address = element("span", null, { className: "fleet-worker-address" });
        const status = element("span", null, { className: "fleet-worker-status" });
        copy.append(name, hardware, address, status);
        const info = element("div", null, { className: "fleet-worker-info" });
        info.append(rail, copy);
        const body = element("div", null, { className: "fleet-worker-details", hidden: true, id: `fleet-node-activity-${worker.id}` });
        body.setAttribute("role", "region");
        body.setAttribute("aria-label", `${nodeLabel(worker.id)} activity`);
        const toggle = element("button", null, { type: "button", className: "fleet-worker-toggle" });
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-label", nodeLabel(worker.id));
        toggle.addEventListener("click", () => this.toggleWorker(worker.id));
        const error = element("p", null, { className: "fleet-worker-error", hidden: true });
        error.setAttribute("role", "alert");
        root.append(info, toggle, error, body);
        row = { root, handle, hardware, address, status, toggle, error, body };
        this.workerRows.set(worker.id, row);
      }
      // Keep the same switch elements so periodic refreshes never steal keyboard focus.
      if (this.workers.children[index] !== row.root) this.workers.insertBefore(row.root, this.workers.children[index] ?? null);
      row.root.dataset.enabled = String(Boolean(worker.enabled));
      row.address.textContent = worker.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
      const info = this.state.hardware?.[worker.id];
      renderHardware(row.hardware, info?.url === worker.url ? info : null);
      const jobs = workerJobs(this.state.jobs, worker.id);
      row.root.dataset.active = String(jobs.some(job => job.occupied));
      const suspensions = this.state.suspensions.filter(item => item.worker_id === worker.id &&
        this.state.jobs.some(job => job.batch_id === item.batch_id && job.state === "waiting"));
      row.status.hidden = Boolean(jobs.length && worker.enabled && this.workerSaving !== worker.id);
      row.status.textContent = this.workerSaving === worker.id ? "Saving…" :
        suspensions.length ? "Batch needs attention" : worker.enabled ? "Waiting for work" : "Disabled";
      row.toggle.setAttribute("aria-checked", String(Boolean(worker.enabled)));
      row.toggle.title = `${worker.enabled ? "Disable" : "Enable"} ${nodeLabel(worker.id)}`;
      row.toggle.disabled = controlsBusy;
      row.handle.disabled = this.workerOrder.isDisabled() || workers.length < 2;
      const error = this.workerError?.id === worker.id ? this.workerError.message : this.state.health[worker.id]?.error;
      if (row.error.textContent !== (error ?? "")) row.error.textContent = error ?? "";
      row.error.hidden = !error;
      this.renderWorkerActivity(row, worker, jobs, suspensions, batches);
    });
    this.renderJobProgress();
  }

  render(state, selected) {
    this.state = state;
    this.selected = selected;
    if (!this.initialized) {
      if (!this.statusError) this.message("");
      this.initialized = true;
      const draft = this.restoreDraft();
      if (!state.workers.length || draft) this.beginSetup(state.workers, draft);
    } else if (!state.workers.length && !this.editing) this.beginSetup([]);
    this.updateView();
    if (this.editing) this.renderDraftHardware();
    this.renderQueue();
    this.renderWorkers();
  }
}
