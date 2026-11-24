## 0.1.4 (2026-11-24)

### 🚀 Features

- **rust-server:** serve topology, health, metrics, memory, clear, open, close, checkpoint, rebuild, synonym, and BM25 routes on a cluster node ([204ebcb8](https://github.com/assetcorp/narsil/commit/204ebcb8))
- **rust-server:** import NDJSON on a cluster node through its batch insert with the single-node limits ([1d79adba](https://github.com/assetcorp/narsil/commit/1d79adba))
- **rust-cluster:** serve device sync snapshots and document exports from cluster backups ([340fec4c](https://github.com/assetcorp/narsil/commit/340fec4c))
- **rust-server:** serve search, index create, and index drop through a cluster node ([12e3cf37](https://github.com/assetcorp/narsil/commit/12e3cf37))
- **rust-cluster:** refuse a device or change feed while a registered node runs an older specification version ([88e2c36c](https://github.com/assetcorp/narsil/commit/88e2c36c))
- **rust-server:** start a cluster node from the launcher's NARSIL_CLUSTER settings when built with the cluster feature ([2e755c29](https://github.com/assetcorp/narsil/commit/2e755c29))
- **rust-cluster:** serve the device and change feeds of a cluster index through the node's feed source ([a13066fc](https://github.com/assetcorp/narsil/commit/a13066fc))
- **rust-server:** serve document, count, list, suggest, preflight, and index statistics reads through a cluster node ([2bf5fec3](https://github.com/assetcorp/narsil/commit/2bf5fec3))
- **rust-server:** serve the allocation, replication factor, analysis change, and partition count routes through a cluster node ([e3ed3712](https://github.com/assetcorp/narsil/commit/e3ed3712))
- **rust-server:** front a cluster node behind the cluster feature, with readiness, writes, and the sync and changes settings ([d6bb1b14](https://github.com/assetcorp/narsil/commit/d6bb1b14))
- **rust-server:** take vectors in read projections, returnVectors in index config, and a vectors query parameter on document reads ([62ff343b](https://github.com/assetcorp/narsil/commit/62ff343b))

### 🩹 Fixes

- **rust-cluster:** check a synonym replacement's index and partition count before its rules, as a TypeScript node does ([848aa99f](https://github.com/assetcorp/narsil/commit/848aa99f))
- **rust-server:** resolve anyhow and pin-project to versions that pass the dependency age gate ([022eb1da](https://github.com/assetcorp/narsil/commit/022eb1da))
- **rust-server:** refuse an embedding adapter on a cluster server with CLUSTER_OPERATION_UNSUPPORTED ([e11d8b10](https://github.com/assetcorp/narsil/commit/e11d8b10))
- refuse malformed read projections and boolean index settings, and keep null vector fields ([8c14be83](https://github.com/assetcorp/narsil/commit/8c14be83))
- **server:** read a null projection member and an empty vectors parameter as absent on every document read ([4f404967](https://github.com/assetcorp/narsil/commit/4f404967))
- **server:** answer SEARCH_INVALID_FIELD for a malformed document projection in a search body ([7557b80e](https://github.com/assetcorp/narsil/commit/7557b80e))

### ❤️ Thank You

- assetcorp

## 0.1.3 (2026-11-19)

This was a version bump only for narsil-rust-server to align it with other projects, there were no code changes.

## 0.1.2 (2026-11-17)

This was a version bump only for narsil-rust-server to align it with other projects, there were no code changes.

## 0.1.1 (2026-11-17)

### 🩹 Fixes

- **server:** hold request bodies up to a tenth of process memory by default so bulk vector imports fit ([2b33057e](https://github.com/assetcorp/narsil/commit/2b33057e))

### ❤️ Thank You

- assetcorp