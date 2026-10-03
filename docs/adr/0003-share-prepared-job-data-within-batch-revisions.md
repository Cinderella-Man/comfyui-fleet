---
status: accepted
---

# Share prepared job data within batch revisions

Keep preparing all jobs in the submitting browser, as Fleet does today, and
reduce duplicate storage with a shared prepared base and independent per-job
differences. This preserves the existing browser-close behavior and avoids a
managed browser runtime for preparation at assignment time.

The shared record belongs to a batch revision, rather than to its first job.
Retiring that job must not remove data needed by other jobs. Each job must
reconstruct exactly the execution graph and editor workflow that native
preparation produced; differences cover arbitrary JSON changes, not just seeds
or recognized prompt nodes. Every difference applies directly to its revision's
base, without depending on preceding jobs. A full snapshot is a valid fallback
when its difference would be larger.

Retain the authored source separately from prepared values. Loading a prepared
base plus a job's difference reconstructs that job, but cannot guarantee the
original pre-preparation source required by ADR 0001. The source is captured
before preparation and is what batch editing opens, including authored prompt
templates such as `{a|b}`. Later edits open the latest saved source revision.

On save, prepare and validate the remaining waiting jobs anew from the edited
source using its generation controls, as another Run would, then construct a
new shared base and new differences. Existing prepared variations are not
preserved. Atomically move only those jobs to the new revision, preserving their
identities, ordinals, batch identity, and queue position. Assigned jobs retain
their original data. Preserve unchanged input snapshots, recheck worker
eligibility, and retain the old revision while jobs or retained history still
need it. Save retries reuse
the already prepared request rather than generating another set of variations.

Existing queued jobs are discarded on upgrade, as agreed in ADR 0001; their
missing authored source does not need to be reconstructed. Existing assigned
jobs must retain the prepared data needed to finish and report their results.

Minimize migration code. Use a one-time, schema-version-guarded upgrade and reuse
existing cancellation and cleanup behavior for waiting jobs where possible.
Do not backfill authored sources, generate differences for old queued batches,
or add a migration framework or legacy editing mode. Preserve node configuration,
admission receipts, and records needed to finish assigned work or collect its
results. Carry surviving prepared payloads through the ordinary full-snapshot
representation rather than introducing a separate legacy execution path. The
upgrade must be atomic and must not discard newly submitted jobs on later
restarts.

This changes storage and adds editing of queued work; it does not add support
for workflow behaviors Fleet cannot currently execute.
