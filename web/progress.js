// One selected execution is presented to the native canvas without image previews,
// private Vue/Pinia stores, or fabricated job outcomes.
export const executionEvents = new Set(["execution_start", "execution_cached", "executing",
  "executed", "progress", "progress_state", "execution_success", "execution_error",
  "execution_interrupted", "b_preview", "b_preview_with_metadata", "progress_text"]);

export class SelectedJob {
  constructor(dispatch) {
    this.dispatch = dispatch;
    this.selected = null;
  }

  select(id, snapshot = {}, active = true) {
    // Native executing(null) cancels pending progress RAFs and clears the node.
    this.dispatch("executing", null);
    this.selected = id;
    const terminal = ["execution_success", "execution_error", "execution_interrupted"].some(k => snapshot[k]);
    if (active && !terminal && Object.keys(snapshot).length) {
      this.dispatch("execution_start", snapshot.execution_start ?? { prompt_id: id });
      for (const type of ["execution_cached", "executing", "progress_state", "progress"]) {
        if (snapshot[type]) this.accept({ job_id: id, type, detail: snapshot[type] });
      }
    }
  }

  accept(event) {
    if (!this.selected || event.job_id !== this.selected || !executionEvents.has(event.type)) return false;
    if (["b_preview", "b_preview_with_metadata", "executed"].includes(event.type)) return false;
    const detail = event.type === "executing" ? event.detail.display_node ?? event.detail.node : event.detail;
    this.dispatch(event.type, detail);
    if (["execution_success", "execution_error", "execution_interrupted"].includes(event.type)) {
      this.dispatch("executing", null);
    }
    return true;
  }

  dispose() {
    this.selected = null;
    this.dispatch("executing", null);
  }
}
