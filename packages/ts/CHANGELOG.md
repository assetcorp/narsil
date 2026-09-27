## 0.3.0 (2026-09-27)

### 🚀 Features

- **spec, ts:** add query-keyed replicas and cluster facet ranges ([be9959b2](https://github.com/assetcorp/narsil/commit/be9959b2))
- **ts, spec, embeddings-transformers:** address several issues across packages ([3cf61919](https://github.com/assetcorp/narsil/commit/3cf61919))
- **spec:** specify exact vector match counts and cursor-depth paging ([af532825](https://github.com/assetcorp/narsil/commit/af532825))
- **ts:** report exact vector match counts and page by cursor depth ([e4dcf563](https://github.com/assetcorp/narsil/commit/e4dcf563))
- **ts:** add server.shutdown and report failed worker actions ([3d97163c](https://github.com/assetcorp/narsil/commit/3d97163c))
- **ts, benchmarks:** report vector search path and pin suite backends ([b1740112](https://github.com/assetcorp/narsil/commit/b1740112))
- **benchmarks:** generate README headlines from the recorded server run ([868079cf](https://github.com/assetcorp/narsil/commit/868079cf))
- **ts, spec:** checkpoint vectors incrementally into immutable files ([f05d59e9](https://github.com/assetcorp/narsil/commit/f05d59e9))
- **ts:** serialise captured partitions off-thread and reclaim idle heap ([10b6a5e6](https://github.com/assetcorp/narsil/commit/10b6a5e6))
- **ts, spec:** write a whole-partition segment when most of it changed ([ea0c230f](https://github.com/assetcorp/narsil/commit/ea0c230f))
- **ts, benchmarks:** integrate jemalloc for improved memory management and enhance durability tests ([06a5202f](https://github.com/assetcorp/narsil/commit/06a5202f))
- **ts, benchmarks:** enhance segment handling and durability features ([ddc074f0](https://github.com/assetcorp/narsil/commit/ddc074f0))
- **native, ts:** improve search core functionality ([6b279bee](https://github.com/assetcorp/narsil/commit/6b279bee))
- **ts:** add native core integration and batch insert support ([fd219e2c](https://github.com/assetcorp/narsil/commit/fd219e2c))
- **ts:** add osq_dot_planes_4x4 method to SIMD interface and enhance multi-term pruning logic ([fb620ffb](https://github.com/assetcorp/narsil/commit/fb620ffb))
- **ts:** add multi-term scoring ([de8b78e0](https://github.com/assetcorp/narsil/commit/de8b78e0))
- **ts:** add vector dimension mismatch error handling and implement concurrent vector placement ([8d553be8](https://github.com/assetcorp/narsil/commit/8d553be8))
- **ts:** implement completeGraph method for vector indexing and enhance checkpoint worker functionality ([13802354](https://github.com/assetcorp/narsil/commit/13802354))
- **ts:** add osq_dot_planes for optimised vector distance calculations using SIMD ([b770f19b](https://github.com/assetcorp/narsil/commit/b770f19b))
- **ts:** enhance vector query functionality with oversample parameter and update error handling for snapshot restoration ([cf9a6ea6](https://github.com/assetcorp/narsil/commit/cf9a6ea6))
- **ts:** introduce new VectorStorageMode type and enhance vector search functionality with efSearch parameter ([20067089](https://github.com/assetcorp/narsil/commit/20067089))
- **ts:** add VectorStorageMode type and enhance frozen segment handling with lazy surface reading ([866769f2](https://github.com/assetcorp/narsil/commit/866769f2))
- **ts:** implement Optimised Scalar Quantisation (OSQ) ([cf015aa7](https://github.com/assetcorp/narsil/commit/cf015aa7))
- **ts:** add oversample parameter support for vector queries ([52b7b0fb](https://github.com/assetcorp/narsil/commit/52b7b0fb))
- **ts:** add function to verify worker distribution of segment builds ([52da784c](https://github.com/assetcorp/narsil/commit/52da784c))
- **ts:** add unbroadcast segment management for improved compaction handling ([b6ac43f1](https://github.com/assetcorp/narsil/commit/b6ac43f1))
- **ts:** improve memory management in worker resource limits ([d0a2f986](https://github.com/assetcorp/narsil/commit/d0a2f986))
- **ts:** implement memory management improvements in vector indexing and worker resource limits ([714b15fd](https://github.com/assetcorp/narsil/commit/714b15fd))
- **ts:** enhance partition filtering and HNSW locking mechanisms ([ba083740](https://github.com/assetcorp/narsil/commit/ba083740))
- **ts:** implement shared graph construction for HNSW indexing ([eb2550e8](https://github.com/assetcorp/narsil/commit/eb2550e8))
- **benchmarks:** introduce run ID for multi-VM execution ([4d15ef1d](https://github.com/assetcorp/narsil/commit/4d15ef1d))
- **benchmarks:** improve benchmarks with new concurrency and tests ([65260ae8](https://github.com/assetcorp/narsil/commit/65260ae8))
- **ts:** enhance document write operations ([4fcf5661](https://github.com/assetcorp/narsil/commit/4fcf5661))
- **ts:** share main thread in local engine ([5e46c97b](https://github.com/assetcorp/narsil/commit/5e46c97b))
- **ts:** enhance worker configuration validation and update main copy query handling in orchestration ([382de901](https://github.com/assetcorp/narsil/commit/382de901))
- **ts:** introduce MainCopyQueries type and integrate into worker configuration for query handling ([52527d46](https://github.com/assetcorp/narsil/commit/52527d46))
- **ts:** implement heap pressure monitoring and reporting ([be369fbc](https://github.com/assetcorp/narsil/commit/be369fbc))
- **ts:** add registryWith function for worker crash handling and repair logic ([f42f5c20](https://github.com/assetcorp/narsil/commit/f42f5c20))
- **ts:** optimise query handling in worker orchestration to improve performance on small indexes ([10c41ed7](https://github.com/assetcorp/narsil/commit/10c41ed7))
- **ts:** implement live tail freezing and enhance partition management for improved query performance ([58946fd4](https://github.com/assetcorp/narsil/commit/58946fd4))
- **ts:** enhance worker pool management and repair logic for improved resilience during worker crashes ([f89b3398](https://github.com/assetcorp/narsil/commit/f89b3398))
- **ts:** improve worker copy functionality and partitioned index operations ([486181c3](https://github.com/assetcorp/narsil/commit/486181c3))
- **ts:** Implement vector graph growth and improve HNSW index ([01fa05b6](https://github.com/assetcorp/narsil/commit/01fa05b6))
- **ts:** enhance index lifecycle management with document count recovery and improve test coverage ([395edffa](https://github.com/assetcorp/narsil/commit/395edffa))
- **ts:** implement index open/close operations and enhance lifecycle management with document count tracking ([db4f511f](https://github.com/assetcorp/narsil/commit/db4f511f))
- **ts:** implement lifecycle management for snapshot durability and enhance catch-up logic in tests ([81210092](https://github.com/assetcorp/narsil/commit/81210092))
- **ts:** enhance index lifecycle management with open/close operations and error codes ([bbd0dee4](https://github.com/assetcorp/narsil/commit/bbd0dee4))
- **ts:** implement mock web worker and enhance worker executor error handling with timeout and crash scenarios ([82e605aa](https://github.com/assetcorp/narsil/commit/82e605aa))
- **ts:** improve grouping with limit support and improve cursor pagination handling for distributed queries ([7f402777](https://github.com/assetcorp/narsil/commit/7f402777))
- **ts:** implement pinned document handling in query routing and enhance cursor pagination tests ([f871f9bc](https://github.com/assetcorp/narsil/commit/f871f9bc))
- **ts:** add match count functionality for full-text queries without scoring and implement related tests ([9e5559f4](https://github.com/assetcorp/narsil/commit/9e5559f4))
- **ts:** enhance multi-node cluster documentation and error handling in transport layer ([3c7b1a75](https://github.com/assetcorp/narsil/commit/3c7b1a75))

### 🩹 Fixes

- **ts, spec, embeddings-transformers:** close further gaps across packag ([4598bdb9](https://github.com/assetcorp/narsil/commit/4598bdb9))
- **spec, ts:** close gaps in pinning, facets, groups, and geo filters ([bd171fdc](https://github.com/assetcorp/narsil/commit/bd171fdc))
- **ts:** reject invalid hybrid fusion config before searching ([497ef876](https://github.com/assetcorp/narsil/commit/497ef876))
- **ts:** cache the operator-set heap limit after the first read ([bda82460](https://github.com/assetcorp/narsil/commit/bda82460))
- **ts:** measure heap pressure against the operator-set limit ([8869c36f](https://github.com/assetcorp/narsil/commit/8869c36f))
- **ts:** report why the native search core failed to load ([660467a6](https://github.com/assetcorp/narsil/commit/660467a6))
- **ts:** tighten public contracts and document engine behaviour ([16217820](https://github.com/assetcorp/narsil/commit/16217820))
- **ts:** skip segment replication when copies do not build segments ([2b69e216](https://github.com/assetcorp/narsil/commit/2b69e216))
- **ts:** register documents when a frozen tail arrives on a copy ([61b5feed](https://github.com/assetcorp/narsil/commit/61b5feed))
- **ts:** catch up worker copies that missed a frozen segment on merge ([9124a43b](https://github.com/assetcorp/narsil/commit/9124a43b))
- **ts:** bound checkpoints and replace workers only after exit ([7d975d35](https://github.com/assetcorp/narsil/commit/7d975d35))
- **ts:** commit a checkpoint only after segments and vectors write ([a17b5cb7](https://github.com/assetcorp/narsil/commit/a17b5cb7))
- **ts:** update quantization logic to reflect new dimension thresholds for OSQ indices ([1be86765](https://github.com/assetcorp/narsil/commit/1be86765))
- **ts:** improve vector index serialization and persistence logic ([72c481e7](https://github.com/assetcorp/narsil/commit/72c481e7))
- use standard spelling for quantization ([4a78bc38](https://github.com/assetcorp/narsil/commit/4a78bc38))
- **ts:** address issues with thread read engine and vector copies ([6c0354a7](https://github.com/assetcorp/narsil/commit/6c0354a7))
- give narsil build more memory ([999f233b](https://github.com/assetcorp/narsil/commit/999f233b))
- **ts:** update write handling and unsupported operations ([5bcad5e4](https://github.com/assetcorp/narsil/commit/5bcad5e4))
- **ts:** add heap pressure check in updateDocument function ([5010f419](https://github.com/assetcorp/narsil/commit/5010f419))
- **ts:** refine worker orchestration and index scaling logic to improve query performance ([1c1c7f9c](https://github.com/assetcorp/narsil/commit/1c1c7f9c))
- **ts:** address issues with document ordinal store ([bf00817a](https://github.com/assetcorp/narsil/commit/bf00817a))
- **ts:** address issues with document encoding and decoding in frozen partition management ([261cb899](https://github.com/assetcorp/narsil/commit/261cb899))
- **ts:** address issues with index state management ([1b456914](https://github.com/assetcorp/narsil/commit/1b456914))
- **ts:** add contentBytes method to DocumentStore ([d05639f8](https://github.com/assetcorp/narsil/commit/d05639f8))
- **ts:** address issues with cursor binding for query and list operations ([8d666ccc](https://github.com/assetcorp/narsil/commit/8d666ccc))

### 🧱 Updated Dependencies

- Updated narsil-embeddings-transformers to 0.2.0

### ❤️ Thank You

- assetcorp

## 0.2.3 (2026-08-30)

### ⚠️ Breaking changes

- **ts:** remove leaseTtlSeconds from EtcdCoordinatorConfig and add ClusterControllerConfig interface with optional properties ([3eabe7c](https://github.com/assetcorp/narsil/commit/3eabe7c))

### 🚀 Features

- **ts:** add new error codes and readiness states to cluster node API ([de7fe75](https://github.com/assetcorp/narsil/commit/de7fe75))
- **ts:** enhance controller election logic with error handling and configuration validation ([2fd004a](https://github.com/assetcorp/narsil/commit/2fd004a))
- **ts:** introduce lastHolders field in partition assignment ([19ba28a](https://github.com/assetcorp/narsil/commit/19ba28a))
- **ts:** implement enhanced handling for unassigned partitions and improve retention logic in cluster node lifecycle ([1f54812](https://github.com/assetcorp/narsil/commit/1f54812))
- **ts:** enhance unassigned partition recovery with unassignedReason and improve cluster event handling ([19c2ae3](https://github.com/assetcorp/narsil/commit/19c2ae3))
- **ts:** improve cluster example ([64d30e7](https://github.com/assetcorp/narsil/commit/64d30e7))
- **ts:** enhance leadership rebalancing and add tests for allocation behavior ([2218b33](https://github.com/assetcorp/narsil/commit/2218b33))
- **ts:** implement query coverage reporting and enhance query configuration options ([f762ce0](https://github.com/assetcorp/narsil/commit/f762ce0))
- **ts:** enhance commit point management in PartitionAssignment and update related replication logic and tests ([e19bccf](https://github.com/assetcorp/narsil/commit/e19bccf))
- **ts:** add commitPoint to PartitionAssignment and update related tests ([5c713f1](https://github.com/assetcorp/narsil/commit/5c713f1))
- **ts:** introduce InMemoryStreamSink interface and enhance stream handling in in-memory transport ([671e338](https://github.com/assetcorp/narsil/commit/671e338))
- **ts:** refactor transport simulation with enhanced stream handling and fault policy integration ([57d8724](https://github.com/assetcorp/narsil/commit/57d8724))
- **ts:** enhance distributed query handling with facet error bounds and improved transport response management ([77a08ef](https://github.com/assetcorp/narsil/commit/77a08ef))
- **ts:** add maxResponseBytes option to client and server APIs for response size control ([45e26a2](https://github.com/assetcorp/narsil/commit/45e26a2))
- **ts:** implement simulated transport and fault policy for enhanced network reliability ([e33aed4](https://github.com/assetcorp/narsil/commit/e33aed4))
- **ts:** enhance index management with index UUIDs and orphaned index handling ([30bb163](https://github.com/assetcorp/narsil/commit/30bb163))
- **ts:** add cluster mode and implement index management features ([fb3941f](https://github.com/assetcorp/narsil/commit/fb3941f))
- **ts:** introduce batch replication for write operations ([3fd8184](https://github.com/assetcorp/narsil/commit/3fd8184))
- **ts:** implement gRPC transport layer with encoding/decoding, error handling, and mutual TLS support ([dafbe9f](https://github.com/assetcorp/narsil/commit/dafbe9f))
- **ts:** improve schema management with listSchemas method and improve replica selection logic ([9928ed6](https://github.com/assetcorp/narsil/commit/9928ed6))
- **ts:** add in-memory transport implementation and update API documentation ([fe15c69](https://github.com/assetcorp/narsil/commit/fe15c69))
- **ts:** add cluster example with TCP transport and mutual TLS support ([5573f32](https://github.com/assetcorp/narsil/commit/5573f32))
- **ts:** add proper facet computation in partitioning ([9cab999](https://github.com/assetcorp/narsil/commit/9cab999))
- **ts:** improve document storage and projection with memory management improvements ([543a85c](https://github.com/assetcorp/narsil/commit/543a85c))
- **ts:** add ClientErrorCodes and ClientErrorCode ([3e666da](https://github.com/assetcorp/narsil/commit/3e666da))
- **ts:** add CLIENT_UNEXPECTED_ERROR code to ClientErrorCodes and update documentation and tests accordingly ([10432c6](https://github.com/assetcorp/narsil/commit/10432c6))
- **ts:** add React integration with hooks for client methods and enhance documentation ([f212b0d](https://github.com/assetcorp/narsil/commit/f212b0d))
- **ts:** introduce narsil client ([16f7e8b](https://github.com/assetcorp/narsil/commit/16f7e8b))
- **ts:** enhance client functionality with new admin operations, error handling, and comprehensive tests ([780e1f4](https://github.com/assetcorp/narsil/commit/780e1f4))
- **ts:** improve task management with new capabilities and types ([da1c65c](https://github.com/assetcorp/narsil/commit/da1c65c))
- **ts:** improve document validation ([ea7169e](https://github.com/assetcorp/narsil/commit/ea7169e))
- **ts:** implement segment compaction and enhance composite partition functionality with new tests ([46d7acd](https://github.com/assetcorp/narsil/commit/46d7acd))
- **ts:** add worker configuration options and new test cases for partition functionality ([b7b3fb7](https://github.com/assetcorp/narsil/commit/b7b3fb7))
- **ts:** enhance http-server and search components with worker configuration and index schema integration ([6841c0a](https://github.com/assetcorp/narsil/commit/6841c0a))
- **ts:** implement batch document insertion with segment replication and validation enhancements ([a6ef9d0](https://github.com/assetcorp/narsil/commit/a6ef9d0))
- **ts:** add segment merging ([ea662b0](https://github.com/assetcorp/narsil/commit/ea662b0))
- **ts:** add posting block bounds and prunable routing functionality ([dac670e](https://github.com/assetcorp/narsil/commit/dac670e))
- **ts:** add OrdinalFilter support to vector search and improve filtering capabilities ([b640d35](https://github.com/assetcorp/narsil/commit/b640d35))
- **ts:** improve document store and partition scoring with field length tracking and score buffering ([a829927](https://github.com/assetcorp/narsil/commit/a829927))
- **ts:** add SharedCopyLoadRequest and SharedGeneration interfaces for vector search ([49c9c21](https://github.com/assetcorp/narsil/commit/49c9c21))
- **ts:** improve sorting to support `includeScores` ([4cd1f10](https://github.com/assetcorp/narsil/commit/4cd1f10))
- **ts:** add ScalarQuantizerCalibration interface and improve vector search ([4a0abd3](https://github.com/assetcorp/narsil/commit/4a0abd3))
- **ts:** implement correct collomn sorting ([08bff43](https://github.com/assetcorp/narsil/commit/08bff43))
- **ts:** implement proper sorting of documents in indexes ([0c29574](https://github.com/assetcorp/narsil/commit/0c29574))
- **ts:** add fold table generation scripts and update project configuration ([93170d0](https://github.com/assetcorp/narsil/commit/93170d0))
- **ci:** add case fold table generation and validation script ([734352d](https://github.com/assetcorp/narsil/commit/734352d))
- **ts:** add sorting and filtering options to document listing and update related components ([4ddc378](https://github.com/assetcorp/narsil/commit/4ddc378))
- **docs:** add document listing feature ([9bde05b](https://github.com/assetcorp/narsil/commit/9bde05b))
- **benchmarks:** implement engine source validation and update README documentation ([cba7d5f](https://github.com/assetcorp/narsil/commit/cba7d5f))
- **ts:** add document projection feature to control returned fields in query results ([c930e90](https://github.com/assetcorp/narsil/commit/c930e90))

### 🩹 Fixes

- **ts:** improve error handling for unassigned partitions and improve partition stores messaging ([028c721](https://github.com/assetcorp/narsil/commit/028c721))
- **ts:** address issues with unassigned partition recovery and partition stores handling ([db406a2](https://github.com/assetcorp/narsil/commit/db406a2))
- **ts:** address issues ([ad029f5](https://github.com/assetcorp/narsil/commit/ad029f5))
- **ts:** add node heartbeat and improve lifecycle management with registration heartbeat ([8172802](https://github.com/assetcorp/narsil/commit/8172802))
- **tests:** update normalizedVector calls to include seed parameter for consistent vector generation ([356f523](https://github.com/assetcorp/narsil/commit/356f523))
- **ts:** add requestId to vector search messages ([7b7a35c](https://github.com/assetcorp/narsil/commit/7b7a35c))
- **ts:** add result window checks for index sorting ([2c3a7c6](https://github.com/assetcorp/narsil/commit/2c3a7c6))

### ❤️ Thank You

- assetcorp

## 0.2.2 (2026-08-04)

### 🩹 Fixes

- **ts:** update VectorQueryConfig to accept Float32Array and adjust query conversion logic ([2f204ea](https://github.com/assetcorp/narsil/commit/2f204ea))

### ❤️ Thank You

- assetcorp

## 0.2.1 (2026-08-04)

This was a version bump only for narsil-ts to align it with other projects, there were no code changes.

## 0.2.0 (2026-08-01)

### 🚀 Features

- **ts:** add TokenizerConfig type to language module exports for enhanced configuration options ([90c3768](https://github.com/assetcorp/narsil/commit/90c3768))
- **ts:** enhance language module management with tokenizer integration and detailed README for language development ([4eb47cb](https://github.com/assetcorp/narsil/commit/4eb47cb))
- **ts:** update language lookalikes and counts for various languages, including new entries and mixed script handling for Cyrillic languages ([745ef3a](https://github.com/assetcorp/narsil/commit/745ef3a))
- **ts:** add support for Belarusian, Georgian, Kazakh, and Maltese languages with stop words and fixtures; enhance CI to check lookalikes ([c3bdd7b](https://github.com/assetcorp/narsil/commit/c3bdd7b))
- **ts:** add language revision management ([111d535](https://github.com/assetcorp/narsil/commit/111d535))
- **ts:** add Turkish stemmer and base stemmer implementation ([b50b744](https://github.com/assetcorp/narsil/commit/b50b744))
- **ts:** implement index analysis rebuild functionality and improve language module revision handling ([5aa42e1](https://github.com/assetcorp/narsil/commit/5aa42e1))
- **ts:** add support for Burmese, Khmer, Lao, and Thai languages ([71d4574](https://github.com/assetcorp/narsil/commit/71d4574))
- **ts:** implement Guarani language support and update Sorani normalization ([45cf168](https://github.com/assetcorp/narsil/commit/45cf168))
- **ts:** add fixtures for multiple new languages ([5303bfa](https://github.com/assetcorp/narsil/commit/5303bfa))
- **ts:** add new languages ([f7af239](https://github.com/assetcorp/narsil/commit/f7af239))
- **ts:** add watermark support and improve rebalance handling ([b2d3cf1](https://github.com/assetcorp/narsil/commit/b2d3cf1))
- **ts:** enhance durability configuration validation and improve error handling for tier and mode settings ([04ba144](https://github.com/assetcorp/narsil/commit/04ba144))
- **ts:** enhance durability configuration with tier selection and improve snapshot management in persistence ([5638658](https://github.com/assetcorp/narsil/commit/5638658))
- **ts:** introduce replication error handling and enhance invalidation integration with new error codes and tests ([9d60348](https://github.com/assetcorp/narsil/commit/9d60348))
- **ts:** implement worker ineligibility checks and enhance language normalization for Dagbani, Japanese, and Twi ([7f53c49](https://github.com/assetcorp/narsil/commit/7f53c49))
- **ts:** enhance index metadata and recovery with additional configuration fields ([1ca9458](https://github.com/assetcorp/narsil/commit/1ca9458))
- **ts:** improve durability and snapshot management with stop word list support ([05f6a3d](https://github.com/assetcorp/narsil/commit/05f6a3d))
- **ts:** improve analysis registry with tokenizer and stop word management ([1f0295d](https://github.com/assetcorp/narsil/commit/1f0295d))
- **ts:** add normalizer functions for various languages to handle diacritics and improve tokenization ([0bfe22a](https://github.com/assetcorp/narsil/commit/0bfe22a))

### 🩹 Fixes

- **ts:** update stemmer checks to use null instead of undefined ([6057f79](https://github.com/assetcorp/narsil/commit/6057f79))
- **ts:** address issues with rebalancing ([972d3fd](https://github.com/assetcorp/narsil/commit/972d3fd))

### ❤️ Thank You

- assetcorp

## 0.1.15 (2026-07-23)

### 🚀 Features

- implement validation for request shapes and enhance error handling in server handlers ([a0e9039](https://github.com/assetcorp/narsil/commit/a0e9039))
- add result window and fetch limits to server configuration and enhance error handling for search and multi-get requests ([f08acff](https://github.com/assetcorp/narsil/commit/f08acff))
- integrate Chain of Thought and Context components for enhanced AI interaction in server-app ([647f821](https://github.com/assetcorp/narsil/commit/647f821))

### ❤️ Thank You

- assetcorp

## 0.1.14 (2026-07-08)

This was a version bump only for narsil-ts to align it with other projects, there were no code changes.

## 0.1.13 (2026-07-08)

This was a version bump only for narsil-ts to align it with other projects, there were no code changes.

## 0.1.12 (2026-07-06)

### 🚀 Features

- **ts:** add surface_forms_enabled field to envelope and update documentation for surface forms feature ([d488fd0](https://github.com/assetcorp/narsil/commit/d488fd0))
- **ts:** improve rebalancer functionality to maintain position tracking settings during rebalances and improve deserialization safety ([4a802b8](https://github.com/assetcorp/narsil/commit/4a802b8))
- **ts:** improve surface forms feature and total term frequency calculations in inverted index and surface registry ([fc6446e](https://github.com/assetcorp/narsil/commit/fc6446e))
- **ts:** implement surface forms and prefix matching ([4455c79](https://github.com/assetcorp/narsil/commit/4455c79))

### ❤️ Thank You

- assetcorp

## 0.1.11 (2026-07-06)

This was a version bump only for narsil-ts to align it with other projects, there were no code changes.

## 0.1.10 (2026-07-04)

### 🚀 Features

- improve TypeScript package with durable filesystem and worker thread integration, updating build scripts and improving worker spawning logic ([f2cea39](https://github.com/assetcorp/narsil/commit/f2cea39))
- add browser compatibility checks and Node.js module handling for filesystem and worker threads ([8f95608](https://github.com/assetcorp/narsil/commit/8f95608))

### ❤️ Thank You

- assetcorp

## 0.1.9 (2026-07-04)

### 🚀 Features

- enhance dataset loading and error handling in server-app, introducing document deduplication and embedding planning ([48bc2e4](https://github.com/assetcorp/narsil/commit/48bc2e4))
- implement named embedding adapter registration and recovery, enhancing durability and index management in server-app ([ad6eb4e](https://github.com/assetcorp/narsil/commit/ad6eb4e))
- add Ask feature to server-app example with new AI components and enhance UI interactions ([4d6a8ef](https://github.com/assetcorp/narsil/commit/4d6a8ef))
- integrate OpenAI embeddings and enhance server functionality in server-app example ([6513cff](https://github.com/assetcorp/narsil/commit/6513cff))
- create a new server-app example using TanStack Start with Narsil HTTP server integration ([243ee4e](https://github.com/assetcorp/narsil/commit/243ee4e))

### 🩹 Fixes

- include document IDs in failed entries ([d08654d](https://github.com/assetcorp/narsil/commit/d08654d))
- **ts:** add vector promotion validation and tests ([bc2ef48](https://github.com/assetcorp/narsil/commit/bc2ef48))

### ❤️ Thank You

- assetcorp