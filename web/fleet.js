import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { prepareSnapshots, createBatchId, captureSource, captureContinuation, nativeControls } from "./preparation.js";
import { BatchEditor } from "./editing.js";
import { FleetPanel } from "./panel.js";
import { SelectedJob, executionEvents } from "./progress.js";

const terminal = new Set(["succeeded", "failed", "cancelled"]);

app.registerExtension({
  name: "ComfyUI.Fleet",
  async setup() {
    const original = { queue: app.queuePrompt, fetch: api.fetchApi, dispatch: api.dispatchCustomEvent,
      interrupt: api.interrupt };
    const state = { phase: "connecting", server: null, selected: null, waitingActions: 0, error: null };
    let capabilityError = null;
    let prepareControl;
    let controls;
    try {
      const helper = await import("../../scripts/promotedWidgetControl.js");
      prepareControl = helper.applyPromotedWidgetControl;
      if (typeof prepareControl !== "function" || !app.extensionManager?.registerSidebarTab) {
        throw new Error("Required frontend extension interfaces are unavailable");
      }
      try {
        const widgets = await import("../../scripts/widgets.js");
        controls = nativeControls(widgets.addValueControlWidgets, prepareControl);
      } catch { /* Ordinary submission remains available; growth will explain the limitation. */ }
    } catch (error) { capabilityError = error.message; }
    let serial = Promise.resolve(), refreshTask = null, requestSequence = 0;
    let ws = null, reconnect = null, disposed = false;
    const rawFetch = (route, options) => original.fetch.call(api, route, options);
    const dispatch = (type, detail) => original.dispatch.call(api, type, detail);
    async function json(route, options) {
      const response = await rawFetch(route, options);
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { error: text }; }
      if (!response.ok) {
        const error = new Error(data.error ?? `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return data;
    }
    const post = (route, body, options = {}) => json(route, { ...options, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    function message(text, error = false) {
      state.error = error ? text : null;
      panel.message(text, error);
    }
    async function mutate(route, body = {}) {
      const answer = await post(route, body);
      await refresh();
      return answer;
    }
    const panel = new FleetPanel({
      notify: (text, severity = "success") => {
        if (disposed) return true;
        const toast = app.extensionManager.toast;
        if (typeof toast?.add !== "function") return false;
        toast.add({ severity, summary: "Fleet", detail: text, life: 5000, closable: true });
        return true;
      },
      select,
      retry: refresh,
      editBatch: id => editor.open(id),
      editBatchDetails: id => editor.open(id, "details"),
      renameBatch: (id, name) => mutate(`/fleet/batches/${id}/rename`, { name }),
      discardBatchEdit: id => editor.discardBatch(id),
      cancelQueued: batch_id => mutate("/fleet/queue/cancel", batch_id == null ? {} : { batch_id }),
      reorderBatch: (batch_id, before_batch_id) => mutate("/fleet/queue/reorder", { batch_id, before_batch_id }),
      reorderWorker: (worker_id, before_worker_id) => mutate("/fleet/workers/reorder", { worker_id, before_worker_id }),
      cancelActive: () => mutate("/fleet/jobs/cancel-active"),
      cancelJob: id => mutate("/fleet/jobs/cancel", { job_ids: [id] }),
      backup: () => mutate("/fleet/backup"),
      configure: workers => mutate("/fleet/workers", { workers }),
      checkWorker: url => post("/fleet/workers/check", { url }),
      jobAction: (id, action) => mutate(`/fleet/jobs/${id}/${action}`),
      reenable: (id, worker_id) => mutate(`/fleet/batches/${id}/reenable`, { worker_id }),
    });
    const editor = new BatchEditor(app, prepareControl, post, refresh, message,
      () => state.waitingActions > 0 || ["preparing", "submitting"].includes(state.phase), controls, panel.root);
    const progress = new SelectedJob(dispatch);
    app.extensionManager.registerSidebarTab({ id: "fleet", title: "Fleet", icon: "pi pi-server",
      type: "custom", render: container => {
        // ComfyUI's custom-tab wrapper otherwise grows with its content, leaving
        // the setup scroll area unbounded and the footer below the viewport.
        container.style.height = "100%";
        container.style.minHeight = "0";
        container.append(panel.root);
      } });

    async function select(id) {
      const job = state.server?.jobs.find(r => r.id === id);
      if (!job) throw new Error("Unknown Fleet job");
      state.selected = id;
      progress.select(id, state.server.progress[id] ?? {}, Boolean(job.occupied));
      panel.render(state.server, id);
      if (terminal.has(job.state)) {
        const detail = await json(`/fleet/jobs/${id}`);
        // Only collected controller references go into native result rendering.
        for (const [node, output] of Object.entries(detail.outputs ?? {})) {
          dispatch("executed", { prompt_id: id, node, display_node: node, output });
        }
        dispatch("executing", null);
      }
    }

    function refresh() {
      if (disposed) return Promise.resolve();
      if (!refreshTask) refreshTask = refreshOnce().finally(() => { refreshTask = null; });
      return refreshTask;
    }

    async function refreshOnce() {
      try {
        const before = state.server;
        state.server = await json("/fleet/state");
        await editor.sync(state.server.edit);
        const signature = data => JSON.stringify(data?.jobs.map(r => [r.id, r.state, r.collection_state, r.hidden]));
        if (signature(before) !== signature(state.server)) {
          dispatch("status", { exec_info: { queue_remaining: state.server.jobs.filter(r => r.state === "waiting" || r.occupied).length } });
        }
        if (state.phase === "connecting") {
          state.phase = "ready";
          message("");
        }
        if (!state.server.ready) message(state.server.error, true);
        const selected = state.server.jobs.find(r => r.id === state.selected);
        if (state.selected && (!selected || terminal.has(selected.state))) {
          dispatch("executing", null);
          if (!selected) { state.selected = null; progress.select(null); }
        }
        panel.render(state.server, state.selected);
      } catch (error) { message(`Controller unavailable: ${error.message}`, true); }
    }

    function connectEvents() {
      if (disposed) return;
      const url = new URL(api.apiURL("/fleet/events"), location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url);
      ws.onopen = () => refresh();
      ws.onmessage = async event => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "fleet_preview") return;
          if (!state.server?.jobs.some(r => r.id === payload.job_id)) await refresh();
          if (!state.server?.jobs.some(r => r.id === payload.job_id)) return;
          if (executionEvents.has(payload.type)) {
            (state.server.progress[payload.job_id] ??= {})[payload.type] = payload.detail;
            panel.renderJobProgress();
          }
          progress.accept(payload);
        } catch (error) { message(error.message, true); }
      };
      ws.onclose = () => { if (!disposed) reconnect = setTimeout(connectEvents, 2000); };
    }

    async function prepare(args) {
      state.waitingActions--;
      if (editor.runBlockedReason) {
        message(editor.runBlockedReason, true);
        return false;
      }
      if (args[0] === -1 && state.server?.edit) {
        message("Queue order is locked while a batch is being edited. Add new work at the end.", true);
        return false;
      }
      const count = args[1] ?? 1;
      const options = args[2];
      const targets = Array.isArray(options) ? options : options?.queueNodeIds;
      if (!Number.isInteger(count) || count < 1 || count > 1000 || targets?.length) {
        message("Fleet accepts 1–1000 complete jobs; partial-node execution is unsupported.", true);
        return false;
      }
      if (capabilityError || !state.server?.ready) {
        message(capabilityError ?? "Fleet is unavailable; no jobs accepted.", true);
        return false;
      }
      const requestId = --requestSequence;
      dispatch("promptQueueing", { requestId, batchCount: count });
      state.phase = "preparing";
      message(`Preparing ${count} job${count === 1 ? "" : "s"}. None accepted yet.`);
      let jobs, source;
      try {
        source = captureSource(app);
        jobs = await prepareSnapshots(app, prepareControl, count,
          done => message(`Prepared ${done}/${count} jobs. None accepted yet.`));
      } catch (error) {
        state.phase = "error";
        message(`Preparation failed: ${error.message}. Zero jobs accepted; native seed changes remain.`, true);
        return false;
      }
      const body = { batch_id: createBatchId(), source, jobs, front: args[0] === -1 };
      body.continuation = captureContinuation(app, controls);
      if (new TextEncoder().encode(JSON.stringify(body)).length > 32*1024*1024) {
        state.phase = "error"; message("Prepared batch exceeds 32 MiB; zero jobs accepted.", true); return false;
      }
      state.phase = "submitting";
      message(`Saving ${count} prepared job${count === 1 ? "" : "s"}…`);
      let accepted;
      try { accepted = await post("/fleet/batches", body); }
      catch (error) {
        if (error.status >= 400 && error.status < 500) {
          state.phase = "error"; message(`Batch rejected: ${error.message}. Zero jobs accepted.`, true); return false;
        }
        try { accepted = await json(`/fleet/batches/${body.batch_id}`); }
        catch {
          state.phase = "unknown";
          message(`Admission for ${body.batch_id} is unconfirmed. Check saved controller state before retrying.`, true);
          return false;
        }
      }
      if (!accepted.accepted || accepted.job_ids?.length !== count || accepted.batch_id !== body.batch_id) {
        state.phase = "unknown"; message(`Unexpected admission response for ${body.batch_id}; check saved state.`, true); return false;
      }
      await refresh();
      state.phase = "accepted";
      if (!state.error) message("");
      panel.notify(`Accepted ${count} job${count === 1 ? "" : "s"}. Work will continue if this browser closes.`);
      dispatch("promptQueued", { requestId, number: args[0] ?? 0, batchCount: count });
      await refresh();
      if (!state.selected && state.server.jobs.some(job => job.id === accepted.job_ids[0])) await select(accepted.job_ids[0]);
      return true;
    }

    function queue(...args) {
      if (disposed) return original.queue.apply(this, args);
      if (editor.runBlockedReason) {
        message(editor.runBlockedReason, true);
        return Promise.resolve(false);
      }
      state.waitingActions++;
      const next = serial.then(() => prepare(args));
      serial = next.catch(error => { state.phase = "error"; message(error.message, true); });
      return next;
    }

    function filteredDispatch(type, detail) {
      // Native socket events belong to local callers. While explicitly following
      // a Fleet job, only controller-validated Fleet events drive the canvas.
      if (!disposed && state.selected && executionEvents.has(type)) return true;
      return original.dispatch.call(this, type, detail);
    }

    async function fetchAdapter(route, options = {}) {
      if (disposed || typeof route !== "string") return original.fetch.call(this, route, options);
      const method = (options.method ?? "GET").toUpperCase();
      const path = route.replace(/^\/api(?=\/)/, "");
      const match = path.match(/^\/jobs(?=\/|\?|$)(.*)$/);
      if (match && method === "GET") return rawFetch(`/fleet/jobs${match[1]}`, options);
      const ids = new Set(state.server?.jobs.map(r => r.id) ?? []);
      const single = path.match(/^\/jobs\/([^/]+)\/cancel$/);
      if (single && method === "POST" && ids.has(single[1])) {
        return rawFetch("/fleet/jobs/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_ids: [single[1]] }) });
      }
      if (path === "/jobs/cancel" && method === "POST") {
        const data = JSON.parse(options.body);
        const fleet = data.job_ids.filter(id => ids.has(id)), local = data.job_ids.filter(id => !ids.has(id));
        if (fleet.length) await post("/fleet/jobs/cancel", { job_ids: fleet });
        if (local.length) return original.fetch.call(this, route, { ...options, body: JSON.stringify({ job_ids: local }) });
        return Response.json({ cancelled: true });
      }
      if (["/queue", "/history"].includes(path) && method === "POST") {
        const data = JSON.parse(options.body ?? "{}");
        if (path === "/queue" && data.clear) {
          await mutate("/fleet/queue/cancel");
          return Response.json({ ok: true });
        }
        const fleet = data.clear ? state.server.jobs.filter(r => terminal.has(r.state)).map(r => r.id)
          : (data.delete ?? []).filter(id => ids.has(id));
        if (path === "/queue") for (let offset = 0; offset < fleet.length; offset += 1000) {
          await post("/fleet/queue/cancel", { job_ids: fleet.slice(offset, offset + 1000) });
        }
        if (path === "/history") for (const id of fleet) await post(`/fleet/jobs/${id}/hide`, {});
        if (path === "/history") await refresh();
        if (data.clear) {
          // Clear the controller's native history too; remote worker histories stay untouched.
          return original.fetch.call(this, route, options);
        }
        const local = (data.delete ?? []).filter(id => !ids.has(id));
        if (local.length) return original.fetch.call(this, route, { ...options, body: JSON.stringify({ delete: local }) });
        return Response.json({ ok: true });
      }
      return original.fetch.call(this, route, options);
    }

    async function interrupt(id) {
      if (disposed) return original.interrupt.call(this, id);
      const selected = id ?? state.selected;
      if (!selected) { message("Select a job to cancel; no global interrupt was sent.", true); return; }
      if (state.server?.jobs.some(r => r.id === selected)) await mutate("/fleet/jobs/cancel", { job_ids: [selected] });
      else await api.cancelJob(selected); // Stock atomic exact-ID cancellation.
    }

    app.queuePrompt = queue;
    api.fetchApi = fetchAdapter;
    api.dispatchCustomEvent = filteredDispatch;
    api.interrupt = interrupt;
    const timer = setInterval(refresh, 1000);
    window.comfyFleet = {
      snapshot: () => structuredClone(state), refresh, select,
      dispose() {
        if (state.waitingActions || ["preparing", "submitting"].includes(state.phase)) throw new Error("Cannot detach during admission");
        disposed = true; clearInterval(timer); clearTimeout(reconnect); ws?.close();
        editor.dispose();
        progress.dispose();
        panel.cancelReordering();
        panel.resetAddressCheck();
        panel.dismissNotification();
        panel.confirmation?.cancel();
        app.extensionManager.unregisterSidebarTab("fleet");
        if (app.queuePrompt === queue) app.queuePrompt = original.queue;
        if (api.fetchApi === fetchAdapter) api.fetchApi = original.fetch;
        if (api.dispatchCustomEvent === filteredDispatch) api.dispatchCustomEvent = original.dispatch;
        if (api.interrupt === interrupt) api.interrupt = original.interrupt;
        delete window.comfyFleet;
      },
    };
    await refresh();
    connectEvents();
  },
});
