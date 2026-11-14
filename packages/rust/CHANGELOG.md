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