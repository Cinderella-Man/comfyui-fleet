# Drop missing jobs and resume after node restarts

When a reachable node no longer reports an assigned job in its queue or history,
drop the job as cancelled, release its slot, and continue the remaining queue.
Do not retry the job, suspend its batch, or require manual verification. The
user accepts losing interrupted jobs, typically one per active node, so routine
node restarts must not leave Fleet waiting for an operator.

Keep the existing history/queue/history check so completion between requests
is found before declaring a job missing. Network failures alone do not justify
dropping work. Jobs that remain queued or executing on the node, and jobs with
available history, retain their normal execution and result handling.

Absence is sufficient even when the submission acknowledgement was lost. This
deliberately replaces indefinite reservation of uncertain submissions with a
preference for continued queue progress; a missing job is never submitted again
by Fleet. A late result cannot revive a dropped job. Use cancellation rather
than workflow failure so the remaining batch is not suspended on that node.

On startup, convert previously released unknown jobs and their retired review
counts to cancellations. Unknown jobs that still occupy a slot remain reserved
until their node can be checked.
