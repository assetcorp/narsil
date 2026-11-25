## 0.1.1 (2026-11-25)

### 🚀 Features

- **rust-cluster:** carry foldMarks through cluster analysis changes, backups, and device feeds ([1bf5f955](https://github.com/assetcorp/narsil/commit/1bf5f955))

### 🩹 Fixes

- **cluster:** wait for the new primary to check a demoted in-sync copy before recovery ([142c2a19](https://github.com/assetcorp/narsil/commit/142c2a19))
- **cluster:** answer the last refusal when the window closes before a write leaves the node ([dab03cbd](https://github.com/assetcorp/narsil/commit/dab03cbd))
- **cluster:** cancel handover confirmation during shutdown ([231a6209](https://github.com/assetcorp/narsil/commit/231a6209))
- **cluster:** cancel retry reads and timers during shutdown ([0ea6adec](https://github.com/assetcorp/narsil/commit/0ea6adec))
- **cluster:** end forward waits and handover holds as soon as a node starts to shut down ([8927bf02](https://github.com/assetcorp/narsil/commit/8927bf02))
- **rust:** bound file descriptors in accept queue tests ([a63c21fa](https://github.com/assetcorp/narsil/commit/a63c21fa))
- **rust:** respect kernel caps in accept queue tests ([e536ad25](https://github.com/assetcorp/narsil/commit/e536ad25))
- **rust-cluster:** listen for peers with the largest accept queue that the system allows ([10ae233f](https://github.com/assetcorp/narsil/commit/10ae233f))
- **cluster:** enforce lead handover holds and validate acknowledgements ([253d22f9](https://github.com/assetcorp/narsil/commit/253d22f9))
- **cluster:** hand a partition's lead to an in-sync replica only after it holds every entry of the old primary ([fae7a4b0](https://github.com/assetcorp/narsil/commit/fae7a4b0))
- **cluster:** rerun a search once when the node holding its context answers NODE_NOT_READY ([6ecc86f0](https://github.com/assetcorp/narsil/commit/6ecc86f0))

### ❤️ Thank You

- assetcorp @assetcorp