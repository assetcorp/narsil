---
status: accepted
---

# Close checkpoints an index before it frees the memory

Closing an index frees its heap while its data stays on disk, and the order of those two steps decides who pays. We have decided that a close drains the index's pending writes, checkpoints, which persists the snapshot and reclaims the write-ahead log, and only then frees the heap, the worker copies, and the replication logs, so that a reopen reads one snapshot and replays nothing. Nobody waits on a close, while a reopen answers in front of a waiting request and, on a replica, inside the replication ack window, so the cost moves to the side where no one stands. A close under this order can never lose an acknowledged write.

## Consequences

A close takes as long as a checkpoint of that index. An operation arriving during a close parks until the close finishes and then reopens the index through the normal path. A close never cancels, because the checkpoint has no abort path and a cancelled close would give the arriving operation nothing it could use.
