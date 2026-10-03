# Editing holds the queue at the edited batch

An edit hold prevents assignment from the edited batch and batches after it in
queue order. Earlier batches may continue receiving assignments; when the held
batch reaches the front, no new jobs are assigned. Jobs already assigned keep
their original workflows and continue.

Skipping the edited batch would allow later work to overtake a batch the user
intends to correct. Pausing all assignment immediately would unnecessarily stop
earlier batches, so the hold applies at the edited batch's queue position.

Closing or losing the editing browser leaves the hold in place. Recovery offers
Resume editing or Discard changes and resume; the queue never resumes merely
because the browser disappeared.

Automatically save the edit draft to the controller so Resume editing restores
the latest saved draft. Draft persistence does not alter queued jobs; only Save
to batch applies changes. Preserve the authored draft before job preparation
advances controls, and do not autosave those preparation side effects over it.

Allow one active batch edit across Fleet at a time. Other sessions can see which
batch is being edited; they cannot start another edit while that edit remains
active. Resume editing recovers the existing edit rather than creating a second
one. Enforce a single writer so an old browser session cannot overwrite a
resumed draft or save stale changes.

Lock queue ordering while the edit hold exists. New batches may append, but
reordering or inserting work at the front must not bypass the hold. This rule
must be enforced by the controller as well as reflected in the browser UI.

A successful atomic save replaces the waiting jobs and releases its hold.
Discard changes releases the hold and preserves the previous queued workflows.
Failed preparation or validation leaves the previous jobs and the hold intact,
allowing the user to correct the draft or discard it.
