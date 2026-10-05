---
status: accepted
---

# Resize batches without replaying prepared work

Batch size means the total number of complete workflow jobs in a batch,
including jobs no longer queued. Users can increase or decrease that total;
resizing changes only the waiting work and preserves the batch's identity and
queue position.

Offer resizing only while the batch has queued jobs, with a maximum total of
1,000 jobs. Failed and cancelled jobs continue to count toward that total;
resizing does not promise a target number of successful results. Jobs removed
specifically by shrinking reduce the total instead of increasing the cancelled
count. A batch with no queued jobs leaves Queue and is no longer resizable.

Allow removing every remaining queued job. Reject a requested total below the
number of jobs that can no longer be removed by resizing; never stop assigned
jobs to satisfy a smaller total.

Group renaming and resizing in an Edit batch dialog in the batch menu. Show
Name followed directly by Total jobs, without a current-batch summary or job
state counts between them. Show the number of waiting jobs that will be added
or removed alongside the size change.
Save changes applies both fields atomically; Cancel preserves both previous
values. A name-only change does not prepare or alter any jobs. Edit workflow
remains a separate action with its existing workflow preparation behavior.

Also allow renaming directly in the queue by double-clicking the batch name.
Save when focus leaves the inline field; Enter also saves and Escape discards
the change. Keep the name in Edit batch for an explicit, discoverable option.
Inline renaming changes only the displayed name and uses the existing rename
behavior without taking an edit hold. An empty name is invalid rather than
silently replacing the previous name.

Reuse the edit hold and recovery behavior from ADR 0002: earlier batches may
continue, the edited batch and later batches wait, and closing the browser
leaves a recoverable operation and its hold. Already assigned jobs continue.
Take the hold when Edit batch opens, even for a name-only change, and keep it
until the dialog closes. Only one workflow edit
or batch-details edit can be active at a time, preventing concurrent changes
to the same prepared work. Normal Save or Cancel releases the hold.

Resizing must not restart generation controls at the saved source values and
thereby replay previously generated work. Already assigned and finished jobs
keep their existing data. Implementation simplicity does not justify duplicate
outputs caused by restarting a seed sequence.

Honor the workflow's generation controls, including deliberately fixed seeds.
Continuation must preserve the behavior of other controls instead of resetting
them; resizing does not override fixed seeds or guarantee distinct images when
the workflow itself calls for repeated values.

Reject reuse of the workflow-edit save behavior for resizing: it prepares
waiting work again from the authored source and can repeat seeds already used
by finished jobs. The replacement preserves existing prepared jobs,
removes only the queued tail when shrinking, and prepares only additional jobs
when growing. Additional jobs must continue generation controls instead of
restarting them.

Store the next preparation state separately from the authored source, and
commit added jobs and their advanced state together.
Stock controls that run before generation need their first-use behavior
restored as well as their saved values; simply loading the last seed can repeat
it. Retry must reuse an already prepared addition instead of adding it twice.

Shrinking does not rewind preparation state. A later increase continues past
the furthest prepared values, including those discarded by shrinking. This
avoids replay and does not require a checkpoint for every job.

Existing batches without a continuation checkpoint remain renameable and
shrinkable. Reject growth with an explanation rather than guessing generation
state from prepared jobs. The schema upgrade preserves their queued jobs and
existing edit drafts.

Support native generation controls, including promoted subgraph controls, by
restoring serialized workflow values and priming native first-use state without
advancing values. Retain the native control mode and implementation identity;
reject continuation if they have changed. Custom before/after-queue callbacks
with private state cannot be resumed generically. Such workflows can still be
submitted and edited, but growth is unavailable. Keep authored prompt templates
in the serialized continuation; never use a prepared job as the source.

Keep admission receipts unchanged after resizing so a retry of the original
submission cannot recreate removed jobs or alter its original response. Store
the current total separately, and discard continuation data when the batch no
longer has retained jobs.
