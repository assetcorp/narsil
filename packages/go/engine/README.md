# Narsil Go engine

`github.com/assetcorp/narsil/packages/go/engine` lets a Go program create, change, and search a Narsil index inside its process, with no Node.js server beside it. It offers every single-node operation of the TypeScript package. It analyses text, scores keyword searches, fuses hybrid rankings, and searches vectors through [Narsil's native core in C](https://github.com/assetcorp/narsil/tree/main/packages/native), which the TypeScript package and the Rust crate also call. It saves every file in the layouts of [the Narsil specification](https://github.com/assetcorp/narsil/tree/main/packages/spec), so the TypeScript package can open an index that this module saves, and this module can open one that the TypeScript package saves.

The module needs Go 1.26 or later and a C compiler, because it calls the core through cgo.

```bash skip
go get github.com/assetcorp/narsil/packages/go/engine
```

Each release of the module has a tag of the form `packages/go/engine/vX.Y.Z`, because the go tool finds the versions of a module in a subdirectory of a repository through tags that start with that subdirectory. For that reason, `go get github.com/assetcorp/narsil/packages/go/engine@vX.Y.Z` fetches the release tagged `packages/go/engine/vX.Y.Z`.

## Create, fill, and search an index

```go run
package main

import (
	"context"
	"fmt"
	"log"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func main() {
	if err := run(context.Background(), "./narsil-data"); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context, directory string) error {
	narsil, err := engine.New(ctx, engine.Config{
		Durability: &engine.DurabilityConfig{Directory: directory},
	})
	if err != nil {
		return err
	}
	defer narsil.Shutdown(ctx)

	err = narsil.CreateIndex(ctx, "films", engine.IndexConfig{
		Schema: engine.Schema{
			"title":     engine.FieldString,
			"year":      engine.FieldNumber,
			"embedding": engine.VectorFieldType(3),
		},
	})
	if err != nil {
		return err
	}

	_, err = narsil.InsertBatch(ctx, "films", []*engine.Document{
		engine.DocumentFromMap(map[string]any{"id": "heat", "title": "Heat", "year": 1995, "embedding": []float32{0.9, 0.1, 0.2}}),
		engine.DocumentFromMap(map[string]any{"id": "ronin", "title": "Ronin", "year": 1998, "embedding": []float32{0.8, 0.3, 0.1}}),
		engine.DocumentFromMap(map[string]any{"id": "solaris", "title": "Solaris", "year": 1972, "embedding": []float32{0.1, 0.9, 0.7}}),
	}, engine.InsertOptions{})
	if err != nil {
		return err
	}

	keyword, err := narsil.Query(ctx, "films", engine.QueryParams{
		Term: "ronin",
		Filters: &engine.FilterExpression{Fields: map[string]engine.FieldFilter{
			"year": {Gte: engine.NumberBound(1990)},
		}},
	})
	if err != nil {
		return err
	}
	fmt.Println(keyword.Count, keyword.Hits[0].ID)

	nearest, err := narsil.Query(ctx, "films", engine.QueryParams{
		Mode:   engine.SearchVector,
		Vector: &engine.VectorQueryConfig{Field: "embedding", Value: []float32{0.85, 0.2, 0.15}},
		Limit:  engine.Some(2),
	})
	if err != nil {
		return err
	}
	for _, hit := range nearest.Hits {
		fmt.Println(hit.ID, hit.Score.Or(0))
	}
	return nil
}
```

The program prints `1 ronin`, then `heat` and `ronin` with their cosine scores. With `Durability` set, every acknowledged write goes to a write-ahead log in the directory, and the next `engine.New` on the same directory opens the index with every document. Leave `Durability` out to keep the index in memory alone.

Every method that can fail returns an `*engine.Error`, which `engine.AsError` unwraps. Its `Code` is the same code that the TypeScript package raises for the same input, such as `engine.CodeDocValidationFailed` for a malformed document.

## Building for each platform

The module holds a copy of the core's C sources, so `go build` compiles them along with your program and needs no separate download. Cgo is on by default when Go builds for the machine that it runs on and finds a C compiler, and it is off by default when Go cross-compiles, so a cross-compile has to set `CGO_ENABLED=1` and name a C compiler for the target in `CC`.

| Target | C compiler for a native build | Cross-compiling from Linux |
|---|---|---|
| Linux x64 and arm64 | GCC or Clang from the distribution | `CC="zig cc -target aarch64-linux-gnu"` or `x86_64-linux-gnu` |
| macOS arm64 and x64 | the Xcode Command Line Tools (`xcode-select --install`) | build on a Mac, because linking needs Apple's SDK |
| Windows x64 | MinGW-w64 GCC, such as the one that MSYS2 installs | `CC="zig cc -target x86_64-windows-gnu"` |
| Windows arm64 | Zig or llvm-mingw | `CC="zig cc -target aarch64-windows-gnu"` |

Cgo can't use the Microsoft Visual C++ compiler, so a Windows build needs one of the GNU-compatible compilers above. Zig 0.16.0 builds the Windows arm64 job in this repository's continuous integration, and it cross-compiles the Linux and Windows targets from a Linux machine:

```bash skip
CGO_ENABLED=1 GOOS=windows GOARCH=arm64 CC="zig cc -target aarch64-windows-gnu" go build ./...
```

The race detector runs on every target here except Windows arm64, where Go doesn't support it.

## How the module differs from the TypeScript package

- **Worker copies.** The TypeScript package copies an index into each worker thread once it holds 1,000 documents, because JavaScript threads can't share memory. Goroutines share the heap, so this module keeps one copy of each index and serves its searches from a pool of goroutines once the index crosses the same threshold, which avoids holding the index twice. It raises the same `WorkerPromote` event that the TypeScript package calls `workerPromote`.
- **Adapters, tokenisers, and stop words.** You write embedding adapters, rerank adapters, custom tokenisers, stop-word functions, and plugins in Go. Register each one by name with `RegisterEmbeddingAdapter`, `RegisterRerankAdapter`, `RegisterTokenizer`, or `RegisterStopWords`, or pass it in `engine.Config`, and name it in the index settings, so that a saved index can find it again after a restart.
- **Memory figures.** The engine refuses an insert or update before indexing it could take memory past the block level, as the TypeScript package does, and it gives the same refusal codes and reasons. Its heap figure and the bytes that it charges for each document come from measurements of this module, which [Memory on Go](#memory-on-go) lists.
- **The server stays in TypeScript.** The HTTP server, cluster mode, and the HTTP client stay in the TypeScript package. To call a Narsil server from Go, use [the Go client](https://github.com/assetcorp/narsil/tree/main/packages/go). Because the routes that send sync history to devices belong to the server, `UpdateSync` and `GetSync` store and read the sync setting in the index metadata, and the setting takes effect for devices once a TypeScript server opens the same directory.
- **Unicode version.** Popular query suggestions normalise each phrase to NFKC through `golang.org/x/text`, which carries the Unicode 17.0.0 tables when you build with Go 1.27 or later and the Unicode 15.0.0 tables below that. A phrase that uses a character added after the version that your build carries can normalise differently from a node built on a newer version.

## Memory on Go

The engine measures two figures against `memory.blockWritesAbove` and `memory.resumeWritesBelow`, which apply to both figures as you give them. The process figure is the anonymous and shared resident memory on Linux, the resident memory less the memory that files back on macOS, and the private working set on Windows. On Linux, the process limit is the container's memory limit wherever the container sets one below the host's memory, and otherwise the process's memory plus the memory that the system reports as available, at most the host's total memory. On macOS and Windows, the limit is the host's total memory. Go has no fixed heap limit, so the heap figure applies only when you set `GOMEMLIMIT`, and the engine then compares the memory that the Go runtime holds from the operating system, less the memory that it has returned, with that limit.

Before it indexes a document, the engine charges it these bytes, which sit well above what this module took when it indexed documents of each kind on Linux:

- Unicode normalisation can triple a string's length, so the engine triples the UTF-16 length of each text value, and it counts one term for every two of those units, or one for every unit in a language that indexes n-grams. Each term counts 512 bytes, and each unit counts 24 bytes more. A distinct term of five characters took about 280 bytes of process memory and 224 bytes of heap.
- A field with a custom tokeniser counts the terms that the tokeniser returns at the same rates.
- A term in a partial-word field counts 512 bytes more, and a partial-word term took about 502 bytes of process memory in all.
- A pattern field counts 96 bytes for each UTF-16 unit, which is 32 bytes for each of the three units that case folding can make of one. A pattern term took about 446 bytes of process memory.
- An enum value counts 1,024 bytes, and a distinct enum value took about 546 bytes.
- Every value counts 256 bytes, every property of an object counts 128 bytes more, and every byte of a string, a key, or a binary value counts 16 bytes.
- A vector field counts 4,096 bytes for each document that carries it, or that an embedding adapter fills, plus 16 bytes for each dimension that the schema gives it.

The engine also counts the memory that the write can take beyond its documents. When a partition's growing segment holds 16 MiB or more, the next write that reaches the partition freezes the segment, so the engine counts 6 bytes for each byte that the segment holds. When a write has to copy a partition's published side, it counts 3 bytes for each byte of that side, and it counts the document table chunks that the write can add. Writes in progress on one index share that count, because the engine applies them one at a time.

A restore estimates its memory from the size of the archive before it stages any file, and it refuses with `CodeRestoreMemoryExceeded` when the estimate passes the memory that the process has free. The rates come from 20 archive scenarios that this module restored three times each. Short text, long text, 64-dimension vectors, and 384-dimension vectors each ran with and without durability, while text kept on disk and vectors beside it ran with durability, and every scenario restored both into a new index and over an existing one. Four snapshots from the 0.3.0 release covered the earlier snapshot format. A sampler read the Go heap and the process memory every 100 to 200 microseconds during each restore. A restore over an existing index takes the highest rate that any scenario reached, raised by a quarter, because the existing index holds its memory until the swap, while a restore into a new index takes the lowest rate, lowered by a fifth.

The module passes [the conformance suite](https://github.com/assetcorp/narsil/tree/main/packages/conformance), which checks that it reads and writes every kind of Narsil file with the same content as the TypeScript package and that it ranks a fixed set of searches the same way.

## License

Apache-2.0
