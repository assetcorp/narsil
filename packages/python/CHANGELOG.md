## 0.2.0 (2026-11-14)

### 🚀 Features

- **clients:** carry the saved and log sizes in the Python and Go stats models ([b52c4c95](https://github.com/assetcorp/narsil/commit/b52c4c95))
- **python:** follow the change feed from the Python client through the changes extra ([76909605](https://github.com/assetcorp/narsil/commit/76909605))
- **python:** add the delali-narsil package that searches inside a Python process ([9f486f6e](https://github.com/assetcorp/narsil/commit/9f486f6e))

### 🩹 Fixes

- answer query suggestions, cluster health, grouping, and /version correctly ([7511228b](https://github.com/assetcorp/narsil/commit/7511228b))
- **memory:** count only memory that no file backs in the process figure ([0cf8f065](https://github.com/assetcorp/narsil/commit/0cf8f065))
- **changes:** read binary values as vectors only at the paths that subscribed lists, and accept a resync as the first message ([613748e3](https://github.com/assetcorp/narsil/commit/613748e3))
- **python:** refuse a callback's call into the engine that waits for it, and raise the TypeScript error codes ([54922512](https://github.com/assetcorp/narsil/commit/54922512))
- **python:** convert a dict that changes during conversion, raise NarsilError for an out-of-range date, and pin colorama for Windows ([673ce416](https://github.com/assetcorp/narsil/commit/673ce416))

### ❤️ Thank You

- assetcorp

## 0.1.1 (2026-11-11)

### 🚀 Features

- **clients:** encode non-finite hit scores in HTTP and the Python and Go clients ([59372fd1](https://github.com/assetcorp/narsil/commit/59372fd1))

### 🩹 Fixes

- **ci:** allow the crate's publish workflow a trusted-publishing token and regenerate the OpenAPI file and clients ([1abda565](https://github.com/assetcorp/narsil/commit/1abda565))

### ❤️ Thank You

- assetcorp