---
status: accepted
---

# Full-precision vectors stay on disk and the graph grows from codes

The engine keeps every full-precision vector in memory, so a million DBpedia vectors of 1,536 dimensions take 6.1 GB of floats before any code, graph, or text, and no code size can bring that figure down. A 1-bit code for the same million vectors takes 0.2 GB and the graph 0.14 GB. Elasticsearch budgets memory for a BBQ index at `num_vectors * (dims / 8 + 14)` bytes and leaves the raw vectors to the page cache, and Qdrant's guide recommends its mode with original vectors cold on disk and quantized vectors pinned in memory for shrinking memory while keeping speed. Narsil also runs embedded and in a browser, where it has no file it can read by position.

We have decided that an index takes a storage setting with the values `memory` and `disk`. When the setting is absent, an index with filesystem durability uses `disk` and every other index uses `memory`, and a request for `disk` without a filesystem fails with `CONFIG_INVALID`. A `disk` index keeps its codes and its graph in memory and reads a full-precision vector from its vector file by position when a search re-scores a candidate or a caller fetches a document. Every quantized index, in either mode, places a new vector in the graph by scoring it as a query against the codes of its neighbours, which is how Lucene scores a merge, so the build never reads a neighbour's floats. The vector file stores its vectors as fixed-size float32 records at the end of the payload in parts of 65,536 vectors, so a reader computes where a vector lies without decoding the file, and no file passes the 4 GiB the envelope header can describe.

## Considered options

Keeping the floats in memory and shrinking only the codes saves at most a fifth of the memory, because the floats are five sixths of it. Building the graph from floats read off disk would read the vectors of every neighbour a new vector is compared against, which is thousands of positional reads per insert on top of the thirty a query makes. A setting the engine chooses on its own, with no override, would leave a deployment unable to pin a small index in memory for speed or to push a large one to disk on a machine where the durability directory is absent by design. Splitting the vector file by a byte size in place of a vector count would make the position of a vector depend on the file it fell in.

## Consequences

A query at `k` of 10 with a 3x rescore reads 30 vectors from the vector file, which took 0.7 to 0.8 µs each from the file cache on an Apple M3 Pro, and a cold read is unmeasured, which Qdrant warns can make the rescore the bottleneck on a slow disk. Recall for a graph built from codes is unmeasured, so the default stays gated on a measurement at 1,536 dimensions on the 100K set before it takes effect. A browser index and an embedded index without durability stay in `memory`, and a browser gains `disk` only once the engine reads the Origin Private File System by position. Every vector file written before this layout is rejected with `ENVELOPE_VERSION_MISMATCH`, because the envelope's compatibility rules now take effect at 1.0.
