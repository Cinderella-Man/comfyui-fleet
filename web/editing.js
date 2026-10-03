import { createBatchId, captureSource, prepareSnapshots } from "./preparation.js";

// The controller owns the draft and hold; this object owns only the open editor session.
export class BatchEditor {
  constructor(app, control, post, refresh, message, isPreparing) {
    Object.assign(this, { app, control, post, refresh, message, isPreparing });
    this.owner = sessionStorage.getItem("fleet-editor-owner") || createBatchId();
    sessionStorage.setItem("fleet-editor-owner", this.owner);
    this.originalLoad = app.loadGraphData;
    this.serial = Promise.resolve();
    this.bar = document.createElement("section");
    this.bar.className = "fleet-edit-bar";
    this.bar.setAttribute("aria-label", "Edit queued workflow");
    this.bar.hidden = true;
    this.label = document.createElement("span");
    this.label.setAttribute("role", "status");
    this.saveButton = this.button("Save to batch", () => this.save());
    this.discardButton = this.button("Discard changes", () => this.discard());
    this.bar.append(this.label, this.discardButton, this.saveButton);
    this.shield = document.createElement("div");
    this.shield.className = "fleet-edit-shield";
    this.shield.hidden = true;
    document.body.append(this.shield, this.bar);
    this.guardKeys = event => {
      if (this.active && (this.busy || this.pending) && event.key !== "Tab" &&
          !this.bar.contains(event.target) && !event.target.closest?.(".fleet-panel")) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", this.guardKeys, true);
    const editor = this;
    app.loadGraphData = this.load = async function (...args) {
      if (editor.busy || editor.closing || editor.isPreparing()) throw new Error("Wait for Fleet to finish preparing jobs before changing workflows");
      await editor.persist();
      const result = await editor.originalLoad.apply(this, args);
      editor.render();
      return result;
    };
    this.runButtons = new Map();
    this.observer = new MutationObserver(() => this.guardRunButtons());
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.timer = setInterval(() => this.tick(), 1000);
    this.onPageHide = () => {
      if (!this.session) return;
      // The durable hold survives; release only the browser's short writer lease.
      const draft = this.active && !this.busy && !this.pending
        ? { source: captureSource(this.app), version: this.session.version } : {};
      this.post("/fleet/edit/release", { ...this.credentials(), ...draft }, { keepalive: true }).catch(() => {});
    };
    window.addEventListener("pagehide", this.onPageHide);
  }

  button(label, action) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = label;
    button.addEventListener("click", () => action().catch(error => this.fail(error)));
    return button;
  }

  get marker() { return this.app.rootGraph.extra?.fleet_edit_id; }
  get active() { return Boolean(this.session && this.marker === this.session.id); }
  credentials() { return { edit_id: this.session.id, token: this.session.token }; }

  fail(error) {
    this.error = error.message;
    if (error.status === 409) { this.session = null; this.pending = null; }
    this.message(error.message, true);
    this.render();
  }

  async sync(hold) {
    this.hold = hold;
    const editId = this.session?.id ?? this.marker;
    if (editId && !this.busy && !this.opening && editId !== hold?.id) await this.finish();
    this.render();
  }

  guardRunButtons() {
    const blocked = Boolean(this.marker);
    for (const button of document.querySelectorAll('[data-testid="queue-button"], .comfy-queue-btn')) {
      if (blocked) {
        if (!this.runButtons.has(button)) this.runButtons.set(button, { disabled: button.disabled, title: button.title });
        button.disabled = true;
        button.title = "Use Save to batch or Discard changes";
      }
    }
    if (!blocked) {
      for (const [button, original] of this.runButtons) Object.assign(button, original);
      this.runButtons.clear();
    }
  }

  render() {
    this.guardRunButtons();
    this.bar.hidden = !this.marker;
    const canvas = this.app.canvas.canvas;
    this.shield.hidden = !canvas || !this.active || !(this.busy || this.pending);
    if (!this.shield.hidden) {
      const bounds = canvas.getBoundingClientRect();
      Object.assign(this.shield.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
      this.shield.textContent = this.pending && !this.busy ? "Save not confirmed. Retry save or discard changes." : "Preparing remaining jobs…";
    }
    this.saveButton.disabled = !this.active || this.busy || this.isPreparing();
    this.discardButton.disabled = !this.active || this.busy;
    this.saveButton.textContent = this.pending ? "Retry save" : "Save to batch";
    this.label.textContent = this.error || (this.busy ? "Preparing and saving remaining jobs…" :
      this.active ? `${this.session.count} queued jobs · ${this.draftStatus || "Draft saved"}` :
        "Resume this batch edit from Fleet’s queue to continue.");
  }

  async open(batchId) {
    if (this.busy || this.opening || this.closing || this.isPreparing()) throw new Error("Wait for the current preparation to finish");
    this.opening = true;
    try {
      await this.persist();
      const session = await this.post("/fleet/edit/begin", { batch_id: batchId, owner: this.owner });
      if (!this.marker) this.returnWorkflow = this.app.extensionManager.workflow.activeWorkflow;
      this.session = session;
      this.pending = null;
      this.error = null;
      this.draftStatus = "Draft saved";
      await this.loadDraft(session.draft);
      await this.refresh();
    } finally { this.opening = false; }
  }

  async loadDraft(source) {
    const graph = JSON.parse(JSON.stringify(source));
    graph.extra = { ...graph.extra, fleet_edit_id: this.session.id };
    // A distinct native tab preserves the user's other open workflows.
    const workflows = this.app.extensionManager.workflow;
    const existing = workflows.openWorkflows?.find(workflow => workflow.activeState?.extra?.fleet_edit_id === this.session.id);
    const name = `Fleet edit ${this.session.id.slice(0, 8)}`;
    await this.originalLoad.call(this.app, graph, true, true, existing ?? name);
    if (this.marker !== this.session.id) throw new Error("ComfyUI could not load the batch workflow. The queue remains held.");
    this.lastSaved = JSON.stringify(source);
    this.render();
  }

  persist(force = false) {
    const next = this.serial.then(async () => {
      if (!this.active || (this.busy && !force) || this.pending) return;
      const source = captureSource(this.app);
      const signature = JSON.stringify(source);
      if (signature === this.lastSaved) return;
      const session = this.session;
      this.draftStatus = "Saving draft…"; this.render();
      const result = await this.post("/fleet/edit/draft", { ...this.credentials(), version: session.version, source });
      if (this.session !== session) return;
      session.version = result.version;
      session.draft = source;
      this.lastSaved = signature;
      this.draftStatus = "Draft saved"; this.error = null; this.render();
    });
    this.serial = next.catch(() => {});
    return next.catch(error => { this.fail(error); throw error; });
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    const session = this.session;
    try {
      if (this.session && Date.now() - (this.lastTouch || 0) > 5000) {
        await this.post("/fleet/edit/touch", this.credentials());
        this.lastTouch = Date.now();
      }
      await this.persist();
      this.render();
    } catch (error) {
      if (this.session === session && !this.busy && !this.opening && !this.closing) this.fail(error);
    } finally { this.ticking = false; }
  }

  async save() {
    if (!this.active || this.busy || this.isPreparing()) return;
    this.busy = true; this.error = null; this.render();
    try { await this.persist(true); }
    catch (error) { this.busy = false; this.render(); throw error; }
    const session = this.session;
    const source = this.pending?.source ?? captureSource(this.app);
    let saved = false;
    try {
      if (!this.pending) {
        // Freeze the authored draft before native callbacks advance seeds/widgets.
        const jobs = await prepareSnapshots(this.app, this.control, session.count);
        const name = source.extra?.fleet?.workflow_name;
        for (const job of jobs) {
          delete job.workflow.extra?.fleet_edit_id;
          if (name) job.workflow.extra = { ...job.workflow.extra, fleet: { ...job.workflow.extra?.fleet, workflow_name: name } };
        }
        this.pending = { ...this.credentials(), operation_id: createBatchId(), batch_id: session.batch_id,
          version: session.version, source, jobs };
      }
      await this.post("/fleet/edit/save", this.pending);
      saved = true;
      await this.finish();
      this.message("Updated the remaining jobs in this batch.");
      await this.refresh();
    } catch (error) {
      // Keep an identical prepared request on ambiguous failure; retry never rerandomizes.
      if (!saved) {
        if (error.status >= 400 && error.status < 500) this.pending = null;
        await this.loadDraft(source);
      }
      throw error;
    } finally { this.busy = false; this.render(); }
  }

  async discardBatch(batchId) {
    if (this.busy || this.opening || this.closing) return;
    if (!this.session || this.session.batch_id !== batchId) {
      this.session = await this.post("/fleet/edit/begin", { batch_id: batchId, owner: this.owner });
    }
    await this.discard();
  }

  async discard() {
    if (!this.session || this.busy) return;
    this.busy = true;
    try {
      await this.serial;
      await this.post("/fleet/edit/discard", this.credentials());
      await this.finish();
      this.message("Discarded batch changes. Queue scheduling can continue.");
      await this.refresh();
    } finally { this.busy = false; this.render(); }
  }

  async finish() {
    if (this.closing) return this.closing;
    const workflows = this.app.extensionManager.workflow;
    const editId = this.session?.id ?? this.marker;
    const draft = workflows.openWorkflows.find(workflow => workflow.activeState?.extra?.fleet_edit_id === editId);
    this.session = null; this.pending = null; this.error = null;
    this.closing = (async () => {
      if (!draft) return;
      // The native store removes a tab without prompting, but does not switch its canvas.
      // Activate another workflow first so its unsaved state and native history survive.
      if (workflows.activeWorkflow === draft) {
        const others = workflows.openWorkflows.filter(workflow => workflow !== draft);
        const previous = others.includes(this.returnWorkflow) ? this.returnWorkflow :
          workflows.getMostRecentWorkflow?.() ?? others[0];
        const graph = previous?.activeState ?? { nodes: [], links: [], groups: [], config: {}, extra: {}, version: 0.4 };
        await this.originalLoad.call(this.app, JSON.parse(JSON.stringify(graph)), true, true, previous ?? null);
      }
      await workflows.closeWorkflow(draft);
    })();
    try { await this.closing; }
    finally { this.closing = null; this.returnWorkflow = null; this.render(); }
  }

  dispose() {
    clearInterval(this.timer);
    this.observer.disconnect();
    for (const [button, original] of this.runButtons) Object.assign(button, original);
    window.removeEventListener("pagehide", this.onPageHide);
    this.onPageHide();
    if (this.app.loadGraphData === this.load) this.app.loadGraphData = this.originalLoad;
    window.removeEventListener("keydown", this.guardKeys, true);
    this.shield.remove();
    this.bar.remove();
  }
}
