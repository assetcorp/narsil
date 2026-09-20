# @delali/narsil-native-win32-arm64

[![npm](https://img.shields.io/npm/v/@delali/narsil-native-win32-arm64)](https://www.npmjs.com/package/@delali/narsil-native-win32-arm64)
[![license](https://img.shields.io/npm/l/@delali/narsil-native-win32-arm64)](https://github.com/assetcorp/narsil/blob/main/LICENSE)

This package holds the native search core of the Narsil search engine, compiled for Windows on 64-bit Arm.

## Install

When you install the library, npm installs this package with it:

```bash
pnpm add -E @delali/narsil
```

Every platform package is an optional dependency of [`@delali/narsil`](https://www.npmjs.com/package/@delali/narsil) at the library's own version, so npm installs only the one whose `os` and `cpu` match your host.

## What it does

Narsil searches each vector field through this core, and it also builds the field's HNSW graph and writes the field's codes through it. The core returns the same documents with the same scores as Narsil's WebAssembly search. Where Node cannot load this binary, Narsil does that work through WebAssembly. To hold a process to the WebAssembly search, set `NARSIL_SEARCH_BACKEND=wasm` before you start it.

## Licence

You may use this package under the Apache-2.0 licence. [assetcorp/narsil](https://github.com/assetcorp/narsil) holds the C source, the build script, and the tests.
