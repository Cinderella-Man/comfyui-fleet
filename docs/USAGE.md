# Using Fleet

First, [install Fleet and add your nodes](INSTALL.md).

## Submit work

Load a workflow and use ComfyUI's **Run** button and count. Each count submits
one complete workflow execution, called a **job**. One click creates a **batch**
of jobs. The count does not change the workflow's internal image batch size.

Fleet assigns one job at a time to each available worker. Once accepted, jobs
stay queued on the controller and continue after you close the browser.
Workers must have the models and custom nodes required by the workflow.
Standard `LoadImage` and `LoadImageMask` files are transferred automatically.

## Choose what runs next

- Drag a batch in **Queue** to change which waiting jobs get the next available
  worker. A batch leaves Queue once all its jobs have been assigned.
- Drag a node under **Your nodes** to change worker preference. Fleet tries the
  first free, enabled, compatible node from the top.

Both orders survive restarts. Reordering leaves jobs already assigned to their
current workers. For keyboard ordering, focus a drag handle, press Space,
move with the arrow keys, then press Space to save or Escape to cancel.

## Cancel work

| Control | What it cancels | What continues |
| --- | --- | --- |
| **Cancel queued jobs** | All jobs waiting for assignment | Assigned jobs |
| **Cancel batch** | Waiting jobs in that batch | Its assigned jobs and other batches |
| **Cancel active jobs** | All assigned Fleet jobs, including those on disabled nodes | Waiting jobs; they can start as workers become free |
| **Cancel job** | The job shown on that node | Other jobs and the queue |

**To stop all Fleet work, cancel queued jobs first, then active jobs.**
These controls affect only Fleet jobs.

## Edit a queued batch

Choose **⋯ → Edit batch** to change its **Name** and **Total jobs** together.
For example, set Total jobs to 200 or 500 to extend a batch beyond ComfyUI's
Run-button limit. Fleet supports up to 1,000 complete workflow jobs per batch;
a workflow job can produce more than one image. The total includes completed,
failed, cancelled, active and queued jobs.

Growing preserves existing prepared jobs and prepares only the additions,
continuing the workflow's generation controls. Shrinking removes jobs from the
queued tail, down to the number that have already started. Removed jobs reduce
the total rather than increasing the cancelled count. Shrinking then growing
continues past the furthest prepared values. Deliberately fixed seeds stay fixed.

Opening the dialog holds this batch and later batches until **Save changes**
or **Cancel** closes it. Name is directly followed by Total jobs, with the number
of jobs to add or remove shown below. A name-only save does not prepare jobs.
Once a batch has no queued jobs, it leaves Queue and cannot be resized.

Older batches without saved generation state, and workflows with custom
generation callbacks Fleet cannot resume, can be renamed or shrunk but cannot
grow. The dialog explains when a new batch is needed. If ComfyUI's control mode
changes between submission and growth, restore that setting or submit a new batch.

For a quick rename, double-click the batch name. Click outside the field or press
Enter to save; Escape discards the change. Empty names are invalid. Inline rename
does not hold the queue. Names persist across refreshes and controller restarts,
and active jobs from that batch show the new name too.

Open a batch’s **⋯** menu and choose **Edit workflow**. Fleet opens a separate
ComfyUI tab containing the original authored workflow, including prompt patterns,
all stages and widget controls. Use **Save to batch** or **Discard changes**;
normal Run is disabled in this tab.
After a successful Save or Discard, Fleet closes the editing tab and returns to
your previous workflow, preserving its unsaved changes.

Only jobs still waiting are changed. Save prepares that many jobs again through
ComfyUI, so random choices are regenerated and counters start from the edited
values. Assigned and finished jobs keep their existing settings and identities.
Unchanged image inputs retain their saved bytes; newly selected inputs are
snapshotted when saving.

One batch can be edited at a time. Earlier batches can continue, but the edited
batch and everything after it cannot start. Queue ordering is locked until the
edit is saved or discarded; new submissions can still append. Assigned jobs continue running.

Drafts save automatically to the controller. Closing the browser keeps the hold;
use **⋯ → Resume editing** to recover the draft, then Save or Discard. Another
browser can resume after the old browser’s short ownership lease expires. A
failed save keeps the original queued jobs and the draft. **Retry save** resends
the same prepared jobs without making new random choices.

## Manage nodes

Use **Manage nodes** to add, rename or remove nodes. Click **Done** to save;
**Discard changes** keeps the saved configuration.

Disabling a node prevents new assignments while its current job continues.
Re-enabling it checks compatibility with waiting jobs before assigning work.

Before removing a node or changing its address, finish or resolve its active
jobs and pending result downloads. Queued jobs need another compatible node;
otherwise finish or cancel them first.

## Find results

Finished jobs appear in ComfyUI's history, where you can view results and load
their workflows. History lasts for the controller's current session; generated
files remain on disk after a restart. [Data retention details](RECOVERY.md#stored-data).

Fleet saves collected files under the controller's output directory. The default
is one folder per job. To change it, set `FLEET_OUTPUT_LAYOUT` in the controller's
environment and restart while Fleet is idle:

| Value | Example path under the output directory |
| --- | --- |
| `job` (default) | `fleet/<job-id>/0001-original.png` |
| `batch` | `fleet/batch-<batch-id>/<job-id>-0001-original.png` |
| `flat` | `fleet/<job-id>-0001-original.png` |

Changing the setting leaves existing files in place. A retried download uses
the layout it started with. Original files also remain on the workers.

## Limits

- Fleet executes whole workflows; partial-node execution is unsupported.
- Browser credentials for ComfyUI API/partner nodes are not forwarded. Workflows
  that depend on those credentials are not supported by Fleet yet.
- Custom nodes that read extra local files need those files on each worker.
  Fleet collects only output files reported by ComfyUI.
- The progress bar measures the current step, not the whole workflow. Fleet
  does not show image previews while a job runs.
- Maximums: 64 nodes, 1,000 jobs per submission, 32 MiB of prepared workflow
  data per submission, and 256 MiB per transferred file.

For failed jobs or downloads, see [troubleshooting](RECOVERY.md#troubleshooting).
