---
status: accepted
---

# Every thread places vectors in one shared graph

The engine builds an HNSW graph for a vector field once that field holds enough vectors, and that build is the slowest work the engine performs while it takes documents in. One core places 300,000 DBpedia vectors of 1,536 dimensions into a graph at m 16 and efConstruction 200 in 616 seconds on an Apple M3 Pro, and at that rate a million vectors would take about 45 minutes, which we have not measured. Qdrant reports 13 minutes and Weaviate 14 minutes for the same dataset on an eight-core server, and both of them reach those totals by using every core of it. The gap we have to close is therefore the single core we built on.

We have decided that every worker thread places vectors into one graph held in shared memory. The adjacency arrays grow in place inside growable shared buffers. A version word guards each node: a writer takes that word for the length of its write, and a reader checks it before and after copying the node's neighbours. The main thread sends each thread a batch of 64 ordinals at a time. Eight threads build that same 300,000-vector graph in 122 seconds, which is five times faster than the one core. That graph answers at recall@10 of 0.996 against a brute-force scan. Lucene chose this shape for its concurrent merge in pull request 12660 and measured 4.4 times at eight threads, while pgvector 0.6 reports 87 minutes on one thread against 9.5 minutes on fifteen.

## Considered options

Splitting the vectors into pieces that each hold their own graph parallelises the build without any locking. We rejected it because every query would then search each piece and fuse the results, which would add latency to every search for as long as the index lives. Building the whole graph on one worker thread takes the work off the main thread without shortening it. A million vectors would still take about 45 minutes there, and every write arriving meanwhile would wait behind that build. Readers that take a counted shared lock on each node were the first shape we built, and at eight threads they lost most of the speed-up, because the counter's cache line moved between cores on every read. The version word replaced that counter, and a search now leaves the shared memory untouched.

## Consequences

A reader copies a node's neighbours between two reads of its version word, and it takes the copy again where a writer moved the word meanwhile. A query that arrives while the threads build therefore waits for one neighbour list at most. Every view over a growable shared buffer has an explicit length, and the thread holding the view rebuilds it once an ordinal falls beyond that length. A view that tracks the buffer's own length forces a synchronised length read on every element, and that read left eight threads a hundred times slower than one. Each thread records the lock it holds in a slot of its own, so the main thread frees what a thread that died mid-insert left behind and sends its batch to another thread. An operation that rewrites the graph in place, which covers compaction, a rebuild, and a restore from disk, takes the graph exclusively while every other thread waits for it.

A browser without `SharedArrayBuffer` keeps the single-thread path behind the same interface, since the buffers fall back to a resizable `ArrayBuffer` and the one thread holds every lock it takes. The threads that hold the field build the graph where the vectors already lie, so the engine drops the promotion build worker and the module that dispatched to it. Where request threads hold the field, each batch goes to them as soon as it arrives, so those threads read every vector without a trip through the main thread.
