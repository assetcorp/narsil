## 0.2.0 (2026-11-19)

### 🚀 Features

- **rust:** accept only the languages that NarsilConfig lists, as the TypeScript engine accepts only registered ones ([efce89b6](https://github.com/assetcorp/narsil/commit/efce89b6))

### 🩹 Fixes

- **python:** retry a snapshot save onto a file that another program holds open on Windows ([f7ba809b](https://github.com/assetcorp/narsil/commit/f7ba809b))
- ⚠️  **rust:** list score components and highlights in the order that the TypeScript engine lists them ([efc81717](https://github.com/assetcorp/narsil/commit/efc81717))
- **release:** rewrite every Cargo.lock that pins a released crate by path ([40b81f49](https://github.com/assetcorp/narsil/commit/40b81f49))
- answer query suggestions, cluster health, grouping, and /version correctly ([7511228b](https://github.com/assetcorp/narsil/commit/7511228b))

### ⚠️  Breaking Changes

- **rust:** list score components and highlights in the order that the TypeScript engine lists them  ([efc81717](https://github.com/assetcorp/narsil/commit/efc81717))

### ❤️ Thank You

- assetcorp

## 0.1.0 (2026-11-13)

### 🚀 Features

- **python:** accept the rewrite budget and report saved and log sizes in the Python engine ([b0a899ca](https://github.com/assetcorp/narsil/commit/b0a899ca))
- **python:** add the delali-narsil package that searches inside a Python process ([9f486f6e](https://github.com/assetcorp/narsil/commit/9f486f6e))

### 🩹 Fixes

- **python:** keep callbacks until the claiming shutdown ends, and refuse a non-string vector text before any hook sees it ([2407eb30](https://github.com/assetcorp/narsil/commit/2407eb30))
- **python:** check for an embedding adapter before refusing a vector query text that is not a string ([a181e3d9](https://github.com/assetcorp/narsil/commit/a181e3d9))
- **python:** raise the TypeScript code for None and bad embedding settings, and refuse a source or destination that calls its engine ([c888c338](https://github.com/assetcorp/narsil/commit/c888c338))
- **python:** raise the rerank config code, free a kept reducer, refuse a bad write count, and keep a refused off's listener ([d0bcd379](https://github.com/assetcorp/narsil/commit/d0bcd379))
- **python:** refuse a callback's call into the engine that waits for it, and raise the TypeScript error codes ([54922512](https://github.com/assetcorp/narsil/commit/54922512))
- **python:** convert a dict that changes during conversion, raise NarsilError for an out-of-range date, and pin colorama for Windows ([673ce416](https://github.com/assetcorp/narsil/commit/673ce416))
- **python:** read a refused dict's ID without running its lookup hooks ([38ae0a66](https://github.com/assetcorp/narsil/commit/38ae0a66))
- **python:** keep callbacks alive through query suggestions, free them with their index, and keep mapping IDs in batch failures ([79ba1a44](https://github.com/assetcorp/narsil/commit/79ba1a44))
- **python:** report unconvertible batch documents, free engines that callbacks refer to, and refuse a stalled nonblocking write ([73725214](https://github.com/assetcorp/narsil/commit/73725214))

### ❤️ Thank You

- assetcorp