# Narsil

Narsil is a distributed full-text search engine. Its on-disk format and its wire protocol both carry across languages. This glossary fixes the vocabulary for the areas where one idea has collected several names.

`packages/spec` holds the cross-language contract, and it takes precedence over this file. Where the two disagree, follow the spec and correct this file.

## Replication

Use these terms when you write about cluster replication.

**Assigned replica**:
An assigned replica is a node whose identifier appears in a partition assignment's replica list. It keeps that role whether or not it currently holds every entry.
_Avoid_: follower, secondary

**In-sync set**:
The in-sync set holds the assigned replicas that have acknowledged every entry up to the commit point. The primary waits for every member before it acknowledges a write, and during failover the controller promotes a member alone. Even so, the primary sends entries to every assigned replica, whether or not that replica belongs to the set. The same field carries the last holders once the partition reaches `UNASSIGNED`.
_Avoid_: ISR, replica set, active set

**Last holders**:
The last holders are the nodes that held a partition when the cluster lost every copy of it, which the controller writes into the assignment's in-sync set as it moves the partition to `UNASSIGNED`. The controller asks each of them which partitions their copy holds once they register again, and it gives the partition back to the first that answers with the data under the index identity the coordinator holds.
_Avoid_: survivors, stale holders, previous owners

**Catching up**:
A catching-up replica is an assigned replica outside the in-sync set that is still receiving entries towards admission.
_Avoid_: repairing, recovering, stale, lagging

**Commit point**:
The commit point is the highest sequence number the primary has acknowledged to a client for a partition, so every replica in the in-sync set holds every entry up to it.
_Avoid_: high watermark, global checkpoint, durability point, committed sequence

**Local log end**:
The local log end is the highest sequence number a node has appended to its own replication log. The value belongs to that node alone.
_Avoid_: committed sequence, commit point

**Admit**:
The primary admits a replica by asking the controller to place it in the in-sync set. The primary sends the opposite request, a removal, when a replica falls behind.
_Avoid_: readmit, rejoin, add, promote

**Bootstrap**:
A bootstrap is a partition's first move out of `INITIALISING` on a node that has newly been assigned it. A replica that has fallen behind returns to the in-sync set by admission instead.
_Avoid_: sync, recovery, initialisation

**Primary term**:
The primary term is a number that rises with each new tenure as primary of a partition. The controller rejects a request carrying a term below the current one, which fences a primary that another node has since replaced.
_Avoid_: epoch, generation, leader term
