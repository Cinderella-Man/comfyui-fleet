// The dialog edits a draft; BatchEditor owns persistence, preparation and its hold.
export class BatchDetailsDialog {
  constructor(root, session, save, cancel) {
    const make = (tag, text, props = {}) => Object.assign(document.createElement(tag), { textContent: text ?? "", ...props });
    this.session = session;
    this.dialog = make("dialog", null, { className: "fleet-confirm" });
    this.dialog.setAttribute("aria-labelledby", "fleet-details-title");
    const form = make("form");
    const name = make("label", "Name", { className: "fleet-rename-field" });
    this.name = make("input", null, { type: "text", value: session.draft.name, maxLength: 200, required: true });
    name.append(this.name);
    const total = make("label", "Total jobs", { className: "fleet-rename-field" });
    this.total = make("input", null, { type: "number", value: String(session.draft.total), min: String(session.minimum), max: "1000", step: "1", required: true });
    total.append(this.total);
    this.change = make("p"); this.change.setAttribute("role", "status");
    this.error = make("p", null, { className: "fleet-rename-error", hidden: true });
    this.error.setAttribute("role", "alert");
    this.cancel = make("button", "Cancel", { type: "button" });
    this.save = make("button", "Save changes", { type: "submit", className: "fleet-primary" });
    const footer = make("footer"); footer.append(this.cancel, this.save);
    form.append(make("h3", "Edit batch", { id: "fleet-details-title" }), name, total, this.change,
      make("p", `Use ${session.minimum}–1,000 jobs. Started jobs keep running.`), this.error,
      make("p", "This batch and later batches stay on hold until you close this dialog."), footer);
    this.dialog.append(form); root.append(this.dialog);
    form.addEventListener("input", () => this.render());
    form.addEventListener("submit", event => { event.preventDefault(); if (this.valid && !this.busy) save(); });
    this.cancel.addEventListener("click", cancel);
    this.dialog.addEventListener("cancel", event => { event.preventDefault(); if (!this.busy) cancel(); });
    this.render(); this.dialog.showModal(); this.name.focus(); this.name.select();
  }

  get value() { return { name: this.name.value.trim(), total: this.total.value === "" ? null : Number(this.total.value) }; }
  get growthError() {
    return this.session.continuation?.error || (!this.session.continuation ? "This older batch has no saved generation state. You can rename or shrink it; submit a new batch to add jobs." : null);
  }
  get valid() {
    const value = this.value;
    return Boolean(value.name && Number.isInteger(value.total) && value.total >= this.session.minimum &&
      value.total <= 1000 && (value.total <= this.session.total || !this.growthError));
  }

  render({ busy = false, pending = false, error = null, progress = null } = {}) {
    this.busy = busy;
    const delta = this.value.total - this.session.total;
    this.change.textContent = progress || (Number.isInteger(this.value.total) ? delta === 0 ? "No jobs added or removed." :
      `${Math.abs(delta)} queued job${Math.abs(delta) === 1 ? "" : "s"} will be ${delta > 0 ? "added" : "removed"}.` : "Enter a whole number of jobs.");
    this.name.disabled = this.total.disabled = busy || pending;
    this.cancel.disabled = busy;
    this.save.disabled = busy || !this.valid;
    this.save.textContent = busy ? "Saving…" : pending ? "Retry save" : "Save changes";
    this.error.textContent = error || (delta > 0 ? this.growthError : "") || "";
    this.error.hidden = !this.error.textContent;
  }

  close() { this.dialog.close(); this.dialog.remove(); }
}
