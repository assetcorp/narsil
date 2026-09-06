---
status: accepted
---

# The workers that hold worker copies receive the HTTP requests

The HTTP server receives every request on the main thread, which parses it, sends the text part to a copy and the vector part to a vector worker, fuses the two answers, pages them, and replies. That work takes about 115 microseconds of the main thread per request, so one server answers about 8,700 hybrid searches a second on an 11-core laptop while the same engine called in-process answers 18,900 and the copies stay idle. Elasticsearch, Typesense, Meilisearch, and Qdrant each keep the thread that parses a request apart from the thread that applies writes. We have decided that the workers holding the copies receive requests themselves as request threads. Each request thread answers a query from its own text copy and the shared vector arena, then fuses, pages, and replies, while the main thread keeps writes, durability, cluster replication, and admin and assigns each new connection to a request thread in turn. Meilisearch and Qdrant end at this shape, and it leaves the copies and the arena from the worker-copy work as they are.

## Considered options

Threads that parse and serialise while forwarding every engine call to the main thread would leave the main thread with about two thirds of its work per request and a ceiling near 15,000. Threads that coordinate only, sending the text part to a copy and the vector part to a vector worker over direct ports, would be a smaller build at about a quarter more CPU per query, and we rejected it because the standard shape would have to replace it later. Eight request threads that each held a private full copy of the index answered only twice as many vector searches as one thread, which points to the eight private copies overflowing the CPU cache, so a request thread shares the frozen segments and the arena with the others.

## Consequences

Under the server every worker in the budget holds a text copy and serves requests, while an embedded engine keeps half its workers for vector search so that the two parts of one search proceed at the same time. The arena reserves a scratch slot for every request thread, and a machine with fewer than three cores keeps one request thread. `maxConcurrentRequests` stays one count across threads, and the cluster node keeps answering transport queries on its main thread until the server has proved the design.
