# Edit queued jobs within their existing batch

Batch edits change only jobs still waiting for assignment. They retain their
batch identity and queue position; already assigned and completed jobs retain
their original workflows. This lets users correct remaining work without
creating a separate batch or rewriting the history of work already started.

Editing uses ComfyUI's full workflow editor and the source workflow as authored
by the user. A representative job's prepared values are not the source to edit:
preparation may already have changed seeds or resolved prompt templates.
For example, a source template such as `{a|b}` remains visible in the editor,
regardless of which value a particular job selected.

The batch menu offers Edit workflow. Prompt copying is outside this feature;
workflows can have multiple prompt sources and do not have one universal prompt
to copy.

Open the source as a separate native ComfyUI workflow tab, preserving the user's
other workflow tabs. The editing tab offers Save to batch and Discard changes.
Ordinary Run, including its keyboard shortcut, is disabled for that tab so it
cannot accidentally create a new batch. Other workflow tabs retain normal Run
behavior.
Successful Save and Discard close the editing tab without a native save prompt.
If it was active, return to the previous open workflow with its unsaved changes
intact; if no other tab remains, open a blank workflow.

Saving prepares the remaining job count anew using the edited source's controls,
as another Run would. Existing per-job variations are replaced by those new
prepared values. The shared storage representation is recorded in ADR 0003.

On upgrade, discard all existing queued jobs. The user explicitly chose this
over supporting source recovery or editing for batches submitted before source
capture was available. Jobs already assigned are outside Queue and are not
cancelled by this migration decision. Do not invent an authored source from a
prepared job snapshot.
