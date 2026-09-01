---
status: accepted
---

# A cluster node closes idle indexes locally, and the controller keeps no record of it

Every index a node holds stays whole in the JS heap whether or not anyone queries it, so under one index per tenant the heap sets how many tenants a node can hold. We have decided that each node closes its own idle indexes by checkpointing them and freeing their memory, that any routed request, replication entry, or explicit open reopens a closed index before it answers, and that the controller, the partition assignments, and the routing tables record nothing about any of it, because a node that reopens on demand still serves every partition the controller believes it serves.

## Considered options

Elasticsearch records a close in cluster state, and its master coordinates the close across shards, but a closed Elasticsearch index rejects every request until an operator reopens it, which is why the cluster has to know. Narsil reopens under the first request that names the index, so the assignment stays true without the controller learning anything, and the wire protocol, the cluster state, and the cross-language spec stay unchanged. We rejected the controller-recorded shape for that reason, and we rejected leaving the replication logs resident, because a four-partition index could keep four in-memory logs of 256 MiB each after its search structures were freed, which would defeat the eviction.

## Consequences

A failover or a bootstrap that touches a closed index pays the reopen before it proceeds. A replica must finish its reopen inside the transport request timeout, 30 seconds by default, or the primary counts the ack as failed and may ask the controller to remove the replica from the in-sync set. Close frees each partition's in-memory replication log along with the index, so a replica that later asks for entries the log no longer holds falls back to bootstrapping from a snapshot, which the recovery path already supports.
