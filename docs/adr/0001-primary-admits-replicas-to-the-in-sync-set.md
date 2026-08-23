---
status: accepted
---

# The primary sends entries to every assigned replica and admits them to the in-sync set

Narsil's primary used to send replication entries only to replicas already in the in-sync set, and a replica rejoined that set by reporting its own completed sync to the controller. Those two rules depend on each other in a circle, because a replica that falls out of the set receives nothing, produces no evidence of its progress, and therefore never returns. We have decided that the primary sends entries to every assigned replica, that in-sync membership governs only which replicas the primary waits for before it acknowledges a write and which replicas may be promoted during failover, and that the primary alone asks the controller to admit a replica.

## Considered options

Kafka, Elasticsearch, and Sirannon all send data to every assigned copy and treat in-sync membership as an observed property. Kafka's leader proposes the change and the controller validates the fencing alone, Elasticsearch blocks its global checkpoint while a replica joins, and Sirannon writes a durability position to its coordinator before it acknowledges each write. We took Kafka's shape for the proposal and the fencing, we took Sirannon's guard of refusing an admission behind a recorded position, and we rejected Sirannon's per-write coordinator update, because a coordinator round trip on every write would cost more than Narsil's indexing rates can afford.

## Consequences

A replica that briefly falls behind now catches up from its own position rather than fetching a whole snapshot, so a short network fault costs far less than it did. The primary has to keep a send cursor for each replica, which it did not do before, and it has to bound the memory those cursors spend. The commit point becomes a value the primary tracks and the allocation table records, which means an assignment carries one more field than it used to. Removing the replica's own admission report also means a replica stops reporting a completed sync on a partition that is already active, and the controller stops accepting one.
