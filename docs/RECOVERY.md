# Node backups and troubleshooting

## Back up nodes

Open **Backup & recovery** in Fleet and click **Back up nodes**. The JSON file
is saved on the controller under `<ComfyUI user directory>/fleet/backups`;
the panel shows its filename. Copy it wherever you keep configuration backups.
You can do this while jobs are running.

The backup contains only node names, addresses, enabled states and their saved
order. It contains no jobs, prompts, workflows, history or input/output files.
It cannot recover a lost queue. It does contain your worker addresses.

## Restore nodes

1. Stop the controller's ComfyUI process.
2. From the ComfyUI directory, run this with its Python environment:

   ```sh
   python custom_nodes/ComfyUI-Fleet/tools/restore.py BACKUP.json user/fleet
   ```

   Replace `BACKUP.json` with the backup's path. If you use a custom ComfyUI user
   directory, replace `user/fleet` with that directory's `fleet` subdirectory.
3. Start ComfyUI. Fleet uses the restored node order and enabled states.

Restoring updates node configuration and preserves any existing jobs. It refuses
changes that would leave active jobs, pending downloads or queued work without
their required nodes. Resolve that work in Fleet before retrying the restore.

## Restart the controller

Leave `<ComfyUI user directory>/fleet` intact. Waiting jobs survive an ordinary restart (see the [0.2.0 upgrade reset](INSTALL.md#upgrade-to-020)),
and Fleet reconnects to remote workers to check work already assigned.
It never automatically reruns interrupted work.

If the controller also uses its own GPU, restarting ComfyUI can interrupt that
job. Remote workers can keep running. Closing the browser does not stop assigned jobs. An open batch edit keeps its
queue hold until you resume editing and choose Save or Discard.

## Restart or power off nodes

You can restart nodes without stopping the queue first. While a node is
unreachable, Fleet keeps its assigned job reserved. When it returns, Fleet
checks that job in the node's queue and history. If the job is still reported,
Fleet continues tracking it or collects its results. If it is missing from
both, Fleet drops it, records it as **Cancelled**, and lets the node take the
next queued job automatically. No manual verification or release is needed.

This accepts losing the jobs that were interrupted, typically one per active
node. Waiting jobs stay queued. Dropped jobs are not retried and do not stop
the node from accepting the rest of their batch. A connection failure alone
does not drop a job; the node must respond to the queue and history checks.
Jobs already manually released by an older Fleet version are counted as
cancelled when the updated controller starts.

## Troubleshooting

| Problem | Action |
| --- | --- |
| Worker cannot be reached | Check its address, port and network access from the controller. See [installation](INSTALL.md#connect-your-workers). |
| Job failed | Fix the workflow or worker, then use **Re-enable batch** to let that worker take remaining jobs from the batch. Use **Run** to submit the failed job again if needed. |
| Results could not be saved | Fleet reports the error, closes the job and continues the queue. The error remains in session history. There are no result recovery actions or retries. |
| Result file is missing (HTTP 404/410) | Fleet skips missing files and saves available results. If no results remain, the history entry is cancelled. No operator action is required. |
| Job says **Checking job** | Fleet checks it automatically. Restore the node's connectivity if it is offline; a job missing from its queue and history will be dropped so queued work can continue. |
| Queue held for editing | Open the batch’s ⋯ menu, choose **Resume editing**, then Save or Discard. Closing a browser does not release this hold. |
| Storage error stops scheduling | Check disk space and permissions, then restart with the same state directory. Do not delete the database to clear the error. |

## Stored data

Fleet keeps job prompts, workflows and input copies on disk while needed for
queued or unfinished work, uncertain outcomes, or result collection. Finished
job records and unused input copies are removed automatically. Authored source and a shared prepared base are kept per batch revision; each job
stores an independent lossless diff, with a full snapshot when smaller. Edit
drafts persist until saved or discarded. A separate preparation checkpoint
allows batch growth to continue native generation controls. It is removed once
the batch has no retained jobs. Small submission and edit
receipts containing IDs and a settings digest remain to prevent duplicate jobs
when a browser retries a request.

Finished-job history is held in memory, capped at 10,000 entries, and cleared
when the controller restarts. ComfyUI's **Clear history** clears both Fleet and
ordinary controller history. It leaves separate workers' history intact.

Clearing history or removing finished job records does not delete generated
files, original inputs, worker files or node backups. Delete those separately
when you no longer need them. Fleet does not store image previews.

See [usage](USAGE.md#find-results) for result locations.
