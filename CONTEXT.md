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
A group of jobs submitted together by one user action.

**Node**:
A connected ComfyUI instance available to execute jobs; also called a worker in
deployment instructions. This is distinct from a node inside a workflow.

**Queue**:
The ordered batches containing jobs that are waiting for assignment to a node.
