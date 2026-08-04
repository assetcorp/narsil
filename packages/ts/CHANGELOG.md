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