---
status: accepted
---

# The worker copy with the fewest queries in flight answers a whole query

Every worker holds a full copy of every scaled-out index, yet the engine split each query by partition across the workers. The engine therefore sent every query on a one-partition index to worker zero while the other copies stayed idle. We have decided that the copy with the fewest queries in flight answers a whole query, and that the engine may split a query naming several partitions across idle copies. The spec now lets any copy answer a query, where it assigned an index to one worker by hash, because throughput under concurrent load comes from many queries on many copies. A split of a query that the engine answers in 0.12 ms has nothing to divide.

## Considered options

Elasticsearch answers each shard search on one thread from a pool of int(cores × 1.5) + 1 threads. Since 8.12 it also splits one query across segments when threads are free, which is the pair of rules we adopted. The previous rule, splitting alone, reached 4,310 queries per second with four copies against 9,197 on one thread for SciFact. Giving the benchmark index as many partitions as workers reached 7,886, still below one thread, because the engine then sent every query to every worker and merged the answers.

## Consequences

A worker copy has to answer at least as fast as the main copy did alone, so a copy merges its segments into one whenever the index is idle. The copy threshold defaults to 1,000 documents, because below that a hop of about 50 microseconds takes longer than the query itself. The engine drops an index's copies after 5 minutes idle and loads them again on the next read or write. The vector pool obeys the same `workers.enabled` switch. The two pools share cores minus one between them until one pool serves both kinds of query.
