## 0.2.3 (2026-11-24)

### 🚀 Features

- **rust-cluster:** port cluster query suggestions with builds on the controller and backed-up query history ([1a1aca33](https://github.com/assetcorp/narsil/commit/1a1aca33))
- **rust-cluster:** rerank on any coordinator through node-level adapters and refuse decoding a read answer that would fill memory ([62d5a415](https://github.com/assetcorp/narsil/commit/62d5a415))
- **rust:** merge a backup's partitions into a device snapshot archive and a document export ([0fd0bbd8](https://github.com/assetcorp/narsil/commit/0fd0bbd8))
- **rust:** give a cluster node the history store and suggestions index config of its host ([9a100952](https://github.com/assetcorp/narsil/commit/9a100952))
- **rust-cluster:** rerank a cluster search through the coordinator's rerank adapter ([4ae8678d](https://github.com/assetcorp/narsil/commit/4ae8678d))
- **rust-cluster:** run backup, restore, and backup deletion jobs on a Rust controller ([2138f6ea](https://github.com/assetcorp/narsil/commit/2138f6ea))
- **rust-cluster:** refuse a device or change feed while a registered node runs an older specification version ([88e2c36c](https://github.com/assetcorp/narsil/commit/88e2c36c))
- **rust-cluster:** check an analysis change against the data node's engine before recording it as pending ([73e850af](https://github.com/assetcorp/narsil/commit/73e850af))
- **rust-cluster:** search across the cluster with cluster-wide scoring, facets, pins, groups, and hybrid fusion ([d4e29557](https://github.com/assetcorp/narsil/commit/d4e29557))
- **rust-cluster:** serve the device and change feeds of a cluster index through the node's feed source ([a13066fc](https://github.com/assetcorp/narsil/commit/a13066fc))
- **rust:** run popular query suggestions through a host that a cluster node can supply ([98efebbe](https://github.com/assetcorp/narsil/commit/98efebbe))
- **rust-cluster:** answer each query at the analysis generation that it names and refuse a search context that would fill memory ([f0c8c107](https://github.com/assetcorp/narsil/commit/f0c8c107))
- **rust-server:** serve the allocation, replication factor, analysis change, and partition count routes through a cluster node ([e3ed3712](https://github.com/assetcorp/narsil/commit/e3ed3712))
- **rust-cluster:** count a query's matches across the cluster with preflight ([9d43e15b](https://github.com/assetcorp/narsil/commit/9d43e15b))
- **rust:** read the device and change feeds through a feed source that the engine implements ([6bd3e1fd](https://github.com/assetcorp/narsil/commit/6bd3e1fd))
- **rust-server:** front a cluster node behind the cluster feature, with readiness, writes, and the sync and changes settings ([d6bb1b14](https://github.com/assetcorp/narsil/commit/d6bb1b14))
- **rust-cluster:** take a backup store in the node config and open it as the node starts ([44b73949](https://github.com/assetcorp/narsil/commit/44b73949))
- **rust:** merge scores, facet buckets, and pins for a cluster coordinator ([c25f3d81](https://github.com/assetcorp/narsil/commit/c25f3d81))
- **rust:** expose the wire form of a backup partition entry and a stored file ([51e22390](https://github.com/assetcorp/narsil/commit/51e22390))
- **rust-cluster:** read documents, counts, stats, listings, completions, and the index list across the cluster ([6e5055c0](https://github.com/assetcorp/narsil/commit/6e5055c0))
- **rust-cluster:** adopt device sync state on copies, answer sync.read, and change sync settings ([362992d8](https://github.com/assetcorp/narsil/commit/362992d8))
- **rust:** back up and restore one partition of a cluster copy as stored backup files ([32a44b92](https://github.com/assetcorp/narsil/commit/32a44b92))
- **rust:** read a document's sort values and widen the partition-scoped suggest limit to the scatter ceiling ([8e188ba1](https://github.com/assetcorp/narsil/commit/8e188ba1))
- **rust:** build an analysis change held aside until the controller releases its generation ([6524bd31](https://github.com/assetcorp/narsil/commit/6524bd31))
- **rust-cluster:** report node memory and block writes when a copy holder is full ([ae518c91](https://github.com/assetcorp/narsil/commit/ae518c91))
- **rust:** collect query statistics and answer suggest, preflight, and list from chosen partitions ([a8d08700](https://github.com/assetcorp/narsil/commit/a8d08700))
- **rust:** search chosen partitions of an index against supplied global statistics ([ac1ea28b](https://github.com/assetcorp/narsil/commit/ac1ea28b))
- **rust:** write and restore the snapshot archive of one partition of a cluster copy ([ec8bd675](https://github.com/assetcorp/narsil/commit/ec8bd675))
- **rust-cluster:** bootstrap primary copies from the allocation table and hold a node with a lost copy out until it fails over ([9837393b](https://github.com/assetcorp/narsil/commit/9837393b))
- **rust:** keep a cluster copy's assigned sequence numbers, terms, and write records ([a5078cca](https://github.com/assetcorp/narsil/commit/a5078cca))
- **rust-cluster:** join a cluster and stand for controller election as a TypeScript node does ([c06befc0](https://github.com/assetcorp/narsil/commit/c06befc0))
- **rust-cluster:** join a Rust process to a cluster over the TCP and gRPC transports and etcd ([64753df9](https://github.com/assetcorp/narsil/commit/64753df9))
- **rust:** leave vector fields out of read results unless the read or the index asks for them ([d811a5e7](https://github.com/assetcorp/narsil/commit/d811a5e7))

### 🩹 Fixes

- **rust-server:** refuse an embedding adapter on a cluster server with CLUSTER_OPERATION_UNSUPPORTED ([e11d8b10](https://github.com/assetcorp/narsil/commit/e11d8b10))
- **rust-cluster:** keep history of an earlier index out of a backup and test suggestions in a mixed cluster ([a8552b91](https://github.com/assetcorp/narsil/commit/a8552b91))
- **rust:** keep the analysis generation of an index without a write-ahead log in memory so a cluster copy answers after a change ([7619b140](https://github.com/assetcorp/narsil/commit/7619b140))
- **rust:** start one held analysis change per pending change and stop a held change that has not claimed the index ([e791659b](https://github.com/assetcorp/narsil/commit/e791659b))
- **cluster-node:** check and reserve process memory before a failed copy's reload decodes its document segments ([8b949206](https://github.com/assetcorp/narsil/commit/8b949206))
- **rust:** fail a cluster copy's log alone when it fails to close, and check memory before a reload decodes vectors and reread a moved checkpoint outside the write lock ([a5930309](https://github.com/assetcorp/narsil/commit/a5930309))
- **rust:** reload a partition from only its own segments and vectors, read before the index's write lock with the checkpoint's files pinned ([ba5f5e3c](https://github.com/assetcorp/narsil/commit/ba5f5e3c))
- **rust:** read a copy's saved write records from their segments, and keep in memory only the records written since the last checkpoint ([9bc58e78](https://github.com/assetcorp/narsil/commit/9bc58e78))
- **rust:** fail a copy that cannot apply an entry, read nil stored settings as absent, and reload one partition's segments alone ([c00e5e95](https://github.com/assetcorp/narsil/commit/c00e5e95))
- **rust:** take a forwarded vector as float32 bytes, write entry vectors as bytes, and refuse every write of a failed put-back as an unknown outcome ([99f648c7](https://github.com/assetcorp/narsil/commit/99f648c7))
- **rust:** fail a cluster copy's log one partition at a time, and repair a torn log tail before a reload resumes it ([1f8a1633](https://github.com/assetcorp/narsil/commit/1f8a1633))
- **cluster:** hold a node that lost its copy out of the cluster until the controller fails that copy over ([c546cab3](https://github.com/assetcorp/narsil/commit/c546cab3))
- **rust:** build the benchmark vector graph before measuring so every run counts the same instructions ([879f30de](https://github.com/assetcorp/narsil/commit/879f30de))
- refuse malformed read projections and boolean index settings, and keep null vector fields ([8c14be83](https://github.com/assetcorp/narsil/commit/8c14be83))
- **rust:** omit vectors addressed through array elements ([a6a40d24](https://github.com/assetcorp/narsil/commit/a6a40d24))

### 🔥 Performance

- **rust:** batch a primary's writes as a standalone batch does ([00b40368](https://github.com/assetcorp/narsil/commit/00b40368))
- **rust:** measure get, get of several IDs, and search on the vector index with vectors asked for ([4eb49674](https://github.com/assetcorp/narsil/commit/4eb49674))
- **rust:** hold the vector choice of a read without a per-read allocation when every vector field gets one answer ([4175f560](https://github.com/assetcorp/narsil/commit/4175f560))
- **rust:** resolve the vector switch without splitting field paths when a read lists no fields ([31e7e685](https://github.com/assetcorp/narsil/commit/31e7e685))
- **rust:** measure search, get, and insert of the Rust engine under CodSpeed ([af7b19ab](https://github.com/assetcorp/narsil/commit/af7b19ab))

### ❤️ Thank You

- assetcorp

## 0.2.2 (2026-11-19)

### 🩹 Fixes

- **rust:** purge jemalloc's arenas when the memory guard frees pages, since malloc_trim reaches only glibc's heap ([b84fb3d6](https://github.com/assetcorp/narsil/commit/b84fb3d6))

### 🔥 Performance

- **rust:** map vector blocks from the kernel with huge pages, so a deleted index returns its memory at once ([22e65fa3](https://github.com/assetcorp/narsil/commit/22e65fa3))
- **rust:** back vector blocks and the server's heap with huge pages, which cut CPU per search at 1M by 3 to 8 percent ([2f37c658](https://github.com/assetcorp/narsil/commit/2f37c658))

### ❤️ Thank You

- assetcorp

## 0.2.1 (2026-11-16)

### 🚀 Features

- **rust-server:** release the server crate to crates.io and document the Rust server ([fb27cd14](https://github.com/assetcorp/narsil/commit/fb27cd14))
- **rust:** accept only the languages that NarsilConfig lists, as the TypeScript engine accepts only registered ones ([efce89b6](https://github.com/assetcorp/narsil/commit/efce89b6))
- **rust:** carry the TypeScript engine's details on every refusal that a caller's request meets ([c8b7edb4](https://github.com/assetcorp/narsil/commit/c8b7edb4))
- **rust:** refuse an insert or update whose memory bound would pass the block fraction ([b4168ae1](https://github.com/assetcorp/narsil/commit/b4168ae1))
- **rust:** carry details on restore staging, segment key, and section offset refusals ([e89933d8](https://github.com/assetcorp/narsil/commit/e89933d8))
- **rust:** carry details on vector file and graph part refusals ([351e13fe](https://github.com/assetcorp/narsil/commit/351e13fe))
- **rust:** carry details on paged segment refusals ([8cf1e8ee](https://github.com/assetcorp/narsil/commit/8cf1e8ee))
- **rust:** carry details on keyword segment refusals ([a5dfa972](https://github.com/assetcorp/narsil/commit/a5dfa972))
- **rust:** carry details on restore validation, checkpoint load, journal, and directory refusals ([4942a313](https://github.com/assetcorp/narsil/commit/4942a313))
- **rust:** carry details on envelope, durable file, log, archive, and manifest refusals ([cc24de75](https://github.com/assetcorp/narsil/commit/cc24de75))
- **rust:** encode MessagePack publicly and bound feed reads the way the TypeScript engine does ([95977870](https://github.com/assetcorp/narsil/commit/95977870))
- **rust:** list documents in a caller's sort order ([1c714770](https://github.com/assetcorp/narsil/commit/1c714770))
- **rust:** expose synonym parsing and document id generation ([5c80e909](https://github.com/assetcorp/narsil/commit/5c80e909))
- **rust:** carry details on engine errors and report them in the server's error body ([ac989feb](https://github.com/assetcorp/narsil/commit/ac989feb))
- **rust-server:** serve the search and query suggestion routes ([343ae2a2](https://github.com/assetcorp/narsil/commit/343ae2a2))
- **rust:** read and write plain JSON and report the process memory limit and rerank window ([4e2c49b9](https://github.com/assetcorp/narsil/commit/4e2c49b9))
- **rust:** publish the sync snapshot on request and raise feed change events ([65e670e7](https://github.com/assetcorp/narsil/commit/65e670e7))

### 🩹 Fixes

- **python:** retry a snapshot save onto a file that another program holds open on Windows ([f7ba809b](https://github.com/assetcorp/narsil/commit/f7ba809b))
- **durability:** retry a Windows rename while another program holds the file so an outside reader cannot stop an index saving ([5aca97bb](https://github.com/assetcorp/narsil/commit/5aca97bb))
- **durability:** recover the committed partition layout ([59d850c4](https://github.com/assetcorp/narsil/commit/59d850c4))
- **persistence:** choose balanced merges and the highest removed share so checkpoints stop rewriting large segments ([991f5fdb](https://github.com/assetcorp/narsil/commit/991f5fdb))
- **rust-server:** refuse a JSON body or import line whose parse would pass the memory block with parse_would_fill_memory ([cbee0e6d](https://github.com/assetcorp/narsil/commit/cbee0e6d))
- **rust-server:** answer a document nested past the parser's depth cap with DOC_VALIDATION_FAILED on every route that parses one ([f2302936](https://github.com/assetcorp/narsil/commit/f2302936))
- **json:** write dates beyond four-digit years as JavaScript's toISOString writes them ([59b53421](https://github.com/assetcorp/narsil/commit/59b53421))
- **engine:** reserve the copy of a shared tail before a write removes from it ([a10ba33f](https://github.com/assetcorp/narsil/commit/a10ba33f))
- **engine:** answer a closed index's sync bounds and feed state from its files without reopening it ([252eb94e](https://github.com/assetcorp/narsil/commit/252eb94e))
- **rust:** keep the shutdown wake for reads waiting on a restore ([b5b93944](https://github.com/assetcorp/narsil/commit/b5b93944))
- **rust:** stop nested listings when shutdown begins ([8998ce82](https://github.com/assetcorp/narsil/commit/8998ce82))
- **rust:** wake restore readers when shutdown begins ([6b2db904](https://github.com/assetcorp/narsil/commit/6b2db904))
- **rust:** stop reads and listings waiting on a shutdown or on their own thread's search ([e7164b6d](https://github.com/assetcorp/narsil/commit/e7164b6d))
- **rust:** report the process's resident memory on macOS and Windows as well as Linux ([644e582f](https://github.com/assetcorp/narsil/commit/644e582f))
- **rust:** build a write's memory reservation only once its compare-and-swap succeeds ([02db76b8](https://github.com/assetcorp/narsil/commit/02db76b8))
- **rust:** reserve write memory in one compare-and-swap so concurrent writes cannot share headroom ([5c357af7](https://github.com/assetcorp/narsil/commit/5c357af7))
- **rust:** carry the refused efSearch and oversample in the details of their refusals ([a3129698](https://github.com/assetcorp/narsil/commit/a3129698))
- **rust:** list indexes in creation order, and after a restart in the order that recovery reads them ([b9700c5b](https://github.com/assetcorp/narsil/commit/b9700c5b))
- ⚠️  **rust:** list score components and highlights in the order that the TypeScript engine lists them ([efc81717](https://github.com/assetcorp/narsil/commit/efc81717))
- **rust:** parse a JSON or MessagePack object with many keys in linear time ([c56592f1](https://github.com/assetcorp/narsil/commit/c56592f1))
- **search:** cap and drop the single group of a query that groups by no field in every engine ([8ad608d0](https://github.com/assetcorp/narsil/commit/8ad608d0))
- **rust:** join vector build threads before releasing files ([cc2a042f](https://github.com/assetcorp/narsil/commit/cc2a042f))
- **rust:** drain reads before releasing index files on shutdown ([e93e08dc](https://github.com/assetcorp/narsil/commit/e93e08dc))
- **rust:** join the vector loader before shutdown returns so that no file of an index stays open ([9fd8a072](https://github.com/assetcorp/narsil/commit/9fd8a072))

### ⚠️  Breaking Changes

- **rust:** list score components and highlights in the order that the TypeScript engine lists them  ([efc81717](https://github.com/assetcorp/narsil/commit/efc81717))

### ❤️ Thank You

- assetcorp

## 0.2.0 (2026-11-14)

### 🚀 Features

- **rust:** share one rewrite budget across a checkpoint and write no segment for an unchanged partition ([c09e40d6](https://github.com/assetcorp/narsil/commit/c09e40d6))
- **rust:** report saved and log sizes, and rewrite segments past a 0.2 removed share ([d136d346](https://github.com/assetcorp/narsil/commit/d136d346))
- **rust:** record previous documents and keep change capture history in the crate ([a1be9f7d](https://github.com/assetcorp/narsil/commit/a1be9f7d))
- **python:** add the delali-narsil package that searches inside a Python process ([9f486f6e](https://github.com/assetcorp/narsil/commit/9f486f6e))

### 🩹 Fixes

- **rust:** verify memory at each embedding write boundary ([2a980270](https://github.com/assetcorp/narsil/commit/2a980270))
- **rust:** ignore zero cgroup limits in the memory test ([4bbdf40e](https://github.com/assetcorp/narsil/commit/4bbdf40e))
- **rust:** remove the memory test allocation deadline ([6c98f88f](https://github.com/assetcorp/narsil/commit/6c98f88f))
- **rust:** check accepted and refused writes against a settled memory reading ([890fac08](https://github.com/assetcorp/narsil/commit/890fac08))
- **rust:** measure memory after the allocator returns free pages in the write-block test ([d261787e](https://github.com/assetcorp/narsil/commit/d261787e))
- answer query suggestions, cluster health, grouping, and /version correctly ([7511228b](https://github.com/assetcorp/narsil/commit/7511228b))
- **memory:** refresh and recheck pressure before applying writes ([a7ca8335](https://github.com/assetcorp/narsil/commit/a7ca8335))
- **memory:** preserve resident fallback for invalid process status ([cbd94060](https://github.com/assetcorp/narsil/commit/cbd94060))
- **memory:** count only memory that no file backs in the process figure ([0cf8f065](https://github.com/assetcorp/narsil/commit/0cf8f065))
- **rust:** join the cold vector loader before a dropped field returns ([7d3238fd](https://github.com/assetcorp/narsil/commit/7d3238fd))
- **rust:** keep each batch refusal across a restore so that no acknowledged document lacks its embedding ([3a51a06c](https://github.com/assetcorp/narsil/commit/3a51a06c))
- **rust:** embed a write again when a restore changes its adapter and write each batch chunk to the restored index ([cd3af4fd](https://github.com/assetcorp/narsil/commit/cd3af4fd))
- **rust:** rerun a reranked query on the index that a restore put in place during its rerank call ([304072ee](https://github.com/assetcorp/narsil/commit/304072ee))
- **rust:** recheck a query's embedding adapter under the read and call the reranker outside every index read ([c1853499](https://github.com/assetcorp/narsil/commit/c1853499))
- **rust:** embed a query's text outside every index read and refuse after three adapter changes ([88d66da7](https://github.com/assetcorp/narsil/commit/88d66da7))
- **rust:** reuse a query's embedding across a restore that keeps its adapter and hold the index for any second embedding ([c7cec9c9](https://github.com/assetcorp/narsil/commit/c7cec9c9))
- **rust:** check paged offsets against their section before sizing a buffer from them ([a3629cfc](https://github.com/assetcorp/narsil/commit/a3629cfc))
- **rust:** refuse a restored paged segment whose postings disagree with its counts or block summaries ([8f9e5117](https://github.com/assetcorp/narsil/commit/8f9e5117))
- **rust:** list each open index under the read hold so that a restore never shows it empty ([1fd235e5](https://github.com/assetcorp/narsil/commit/1fd235e5))
- **rust:** embed a query's text with the adapter of the index that it searches ([1d32ebb4](https://github.com/assetcorp/narsil/commit/1d32ebb4))
- **rust:** refuse a restored paged segment whose ID order does not ascend ([b694e2a1](https://github.com/assetcorp/narsil/commit/b694e2a1))
- **rust:** refuse a shutdown from inside the engine's persistence adapter ([127ccc79](https://github.com/assetcorp/narsil/commit/127ccc79))
- **rust:** record admitting threads in the shutdown gate so a create during thread exit still refuses a nested shutdown ([5e1ba419](https://github.com/assetcorp/narsil/commit/5e1ba419))
- **rust:** close the old index's files before a restore moves them, and reopen them when a move fails ([950be212](https://github.com/assetcorp/narsil/commit/950be212))
- **rust:** keep a close that overlaps shutdown out of the listing and prove the nested create reaches its wait ([4cae9340](https://github.com/assetcorp/narsil/commit/4cae9340))
- **rust:** refuse a shutdown from a callback of the create, restore, or reopen that it would wait for ([a1985da9](https://github.com/assetcorp/narsil/commit/a1985da9))
- **rust:** refuse a publication that arrives while shutdown waits instead of queueing behind it ([2fe4a5ce](https://github.com/assetcorp/narsil/commit/2fe4a5ce))
- **rust:** refuse a segment whose counts differ from the manifest ([4e97327a](https://github.com/assetcorp/narsil/commit/4e97327a))
- **rust:** count only the resident sections of text on disk in a restore's memory check ([76be5a26](https://github.com/assetcorp/narsil/commit/76be5a26))
- **rust:** restore a snapshot whose text is on disk ([9d7bf5ae](https://github.com/assetcorp/narsil/commit/9d7bf5ae))
- **rust:** refuse a drop from a listener before it deletes the source's suggestion indexes ([a4d11b9a](https://github.com/assetcorp/narsil/commit/a4d11b9a))
- **rust:** refuse a listener's change to an index its own call holds, and raise count warnings after the count lock ([b239222c](https://github.com/assetcorp/narsil/commit/b239222c))
- **rust:** let a shutdown inside a build listener skip waiting for that build ([5e1b1f0f](https://github.com/assetcorp/narsil/commit/5e1b1f0f))
- **rust:** let a shutdown from a listener or plugin hook return while another shutdown waits for its thread ([d5c1010c](https://github.com/assetcorp/narsil/commit/d5c1010c))
- **rust:** make every shutdown wait for creates, restores, and reopens without deadlocking ([3e43cd82](https://github.com/assetcorp/narsil/commit/3e43cd82))
- **rust:** make shutdown wait for an index create that is saving ([91735de1](https://github.com/assetcorp/narsil/commit/91735de1))
- **rust:** stop a create's save from blocking other indexes, and refuse a bad custom token with the spec's code ([a567c6ea](https://github.com/assetcorp/narsil/commit/a567c6ea))
- **python:** convert a dict that changes during conversion, raise NarsilError for an out-of-range date, and pin colorama for Windows ([673ce416](https://github.com/assetcorp/narsil/commit/673ce416))

### ❤️ Thank You

- assetcorp

## 0.1.1 (2026-11-11)

### 🩹 Fixes

- **rust:** give each vector store copy its own ID table so a search on the older store never follows an ordinal it lacks ([883e54ee](https://github.com/assetcorp/narsil/commit/883e54ee))

### ❤️ Thank You

- assetcorp