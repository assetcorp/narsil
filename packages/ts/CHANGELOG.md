## 0.2.3 (2026-08-30)

### 🚀 Features

- **ts:** add new error codes and readiness states to cluster node API ([de7fe75](https://github.com/assetcorp/narsil/commit/de7fe75))
- **ts:** remove leaseTtlSeconds from EtcdCoordinatorConfig and add ClusterControllerConfig interface with optional properties ([3eabe7c](https://github.com/assetcorp/narsil/commit/3eabe7c))
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