# Fleet

Fleet distributes complete workflow executions across ComfyUI instances.

## Language

**Controller**:
The ComfyUI instance with Fleet installed, where users submit work and view results.

**Job**:
One complete workflow execution, including its inputs and results, assigned to
at most one node.
_Avoid_: Run (reserved for ComfyUI's button)

**Batch**:
A group of jobs managed together, with one identity and queue position.

**Batch size**:
The total number of jobs in a batch, rather than just the number still queued.
It counts jobs including failed and cancelled jobs, not individual output images.

**Source workflow**:
The workflow as authored by the user, including its connections, prompt templates,
and generation controls, at submission or after a saved edit.

**Batch revision**:
A version of a batch's source workflow from which its jobs were prepared.
After an edit, jobs in the same batch may belong to different revisions.

**Edit draft**:
Proposed changes to a batch's name and size, or to its source workflow, that
have not yet been applied.

**Node**:
A connected ComfyUI instance available to execute jobs; also called a worker in
deployment instructions. This is distinct from a node inside a workflow.

**Queue**:
The ordered batches containing jobs that are waiting for assignment to a node.

**Queued job**:
A job waiting for assignment to a node.

**Dropped job**:
An assigned job that a reachable node no longer reports in its queue or history.
It counts as cancelled and is not automatically retried.

**Edit hold**:
A hold on a batch being edited that prevents new job assignments from that batch
and every batch after it in the queue.
