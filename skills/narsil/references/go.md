# Narsil in Go

The module `github.com/assetcorp/narsil/packages/go/engine` embeds the engine in a Go program, and the separate module `github.com/assetcorp/narsil/packages/go` is the client that calls a server.

## Find the installed version and its API

1. Read the version with `go list -m github.com/assetcorp/narsil/packages/go/engine`, or from `go.mod`.
2. When the module is missing, add it with `go get github.com/assetcorp/narsil/packages/go/engine`. Its releases carry tags of the form `packages/go/engine/vX.Y.Z`, and `go get` takes the plain `@vX.Y.Z` form. It needs Go 1.26 or later and a C compiler, because it compiles Narsil's C core through cgo.
3. Take every type and function from `go doc github.com/assetcorp/narsil/packages/go/engine` or from `https://pkg.go.dev/github.com/assetcorp/narsil/packages/go/engine`. The module's README, which holds a complete example, is in the module cache under `$(go env GOMODCACHE)/github.com/assetcorp/narsil/packages/go/engine@<version>/README.md`.

## Build with it

- `engine.New(ctx, engine.Config{})` keeps every index in memory. Set `Durability: &engine.DurabilityConfig{Directory: dir}` to log every acknowledged write and to find every index again on the next `engine.New`. Call `Shutdown(ctx)` before the program exits.
- Write a schema as an `engine.Schema` of constants such as `engine.FieldString`, `engine.VectorFieldType(384)` for a vector, and `FieldType.WithOptions` with `engine.TextFieldSortable`, `TextFieldPattern`, or `TextFieldPartial` for a text option. Build each document with `engine.DocumentFromMap`.
- `engine.QueryParams` takes the fields of the TypeScript `query` in Go's style, and optional numbers go through `engine.Some`.
- A read leaves out vector fields. Pass `engine.ReturnVectors(true)` to `Get` or `GetMultiple`, or set it as `QueryParams.Document` or `ListParams.Document`, to get them back, or set `ReturnVectors: true` in the `engine.IndexConfig`.
- Every fallible method returns an `*engine.Error`, which `engine.AsError` unwraps, and its `Code` matches the TypeScript code for the same input, such as `engine.CodeDocValidationFailed`.
- Goroutines share one copy of each index, and the engine serves searches from a pool of goroutines once an index holds 1,000 documents.
- Write embedding adapters, rerank adapters, tokenizers, stop word functions, and plugins in Go, and register each one by name with `RegisterEmbeddingAdapter`, `RegisterRerankAdapter`, `RegisterTokenizer`, or `RegisterStopWords`, or pass it in `engine.Config`.
- Cgo is off when Go cross-compiles, so a cross-compile sets `CGO_ENABLED=1` and a C compiler for the target in `CC`, such as `zig cc -target aarch64-linux-gnu`. Cgo can't use the Microsoft Visual C++ compiler, so a Windows build needs MinGW-w64, Zig, or llvm-mingw, and a macOS build needs a Mac.

## Call a server

Add `github.com/assetcorp/narsil/packages/go`, whose releases carry tags of the form `packages/go/vX.Y.Z`. `narsil.New(narsil.Config{URLs: []string{url}, APIKey: key})` returns a client with a typed method for every route of the server, and the client needs neither cgo nor a C compiler.
