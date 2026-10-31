---
status: accepted
---

# A write returns before it reaches every worker copy, and a caller who needs to see it waits for it

A write reaches the worker copies through a queue that the engine does not wait on. For that reason the engine answered every query on the main copy while that queue held anything, so that a caller always read its own write. A request thread answers from its own copy and sends nothing to the main thread, so keeping that rule would send every read back to the main thread whenever writes are in progress. We have decided that a write may return before the copies apply it and that a copy answers from the writes it holds. A caller who needs the next query to see a write can set `wait: true` on that write, or can call `waitForWrites` after a run of writes, so only that caller takes the cost of waiting.

## Considered options

Indexing a document inside the request and replying afterwards would let a read after a write return that document. However, that shape would make every write wait for the slowest copy, and it would remove the queue of up to 20,000 pending documents that lets ingest continue while the copies apply earlier writes. Sending a read to the main thread while the copy behind a request thread has writes pending would keep today's promise, but under sustained writes every read would reach the main thread again, which is the ceiling this work removes.

## Consequences

The spec now says that a worker copy answers from the writes it holds. A test that writes and then queries must pass `wait: true` or call `waitForWrites`, and so must a client that reads its own write across connections. The embedded engine and the HTTP server follow one rule, so the flag means the same thing in both. This decision changes nothing in cluster replication or the in-sync set, because those rules cover the log between nodes while this one covers the copies inside one process.
