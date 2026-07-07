# Roadmap

Narsil is defined by a language-neutral binary format, `.nrsl`, specified in [`packages/spec`](packages/spec). Any implementation that reads and writes the format is a valid Narsil. The TypeScript package is the reference implementation, and every other implementation is checked against it.

This roadmap sets out where the project is heading. It covers direction and intent, and it will change as the work proceeds. It does not commit to dates. To propose or discuss an item, open an issue.

## Available now

- **Embedded engine.** Full-text, vector, hybrid, and geosearch run inside your application process, in Node.js, Bun, Deno, or the browser.
- **Single-node server.** The same engine runs behind a REST API, with a write-ahead log, bulk NDJSON import, and snapshot and restore.
- **The `.nrsl` format.** A single binary format persists and transfers indexes, so a file written by one runtime loads in another.

## In progress

- **Cluster mode.** The multi-node mode under `@delali/narsil/distribution` provides node roles, replication, and query routing, but it runs only in-process today. The work ahead makes it deployable across separate processes and machines, fuses the write-ahead log with replication, and proves failover and recovery under load. This is a major focus for the project.

## Planned

- **A second-language implementation.** A second implementation in Go or Rust will read and write the same `.nrsl` files and pass the same format tests as the reference. The choice between Go and Rust is open, and the decision will weigh runtime footprint, the concurrency model, and the ecosystem each language reaches. This is the headline item, because a second implementation proves the format is portable across languages.
- **A conformance suite for the format.** A shared set of format tests will let any implementation, in any language, check that it reads and writes `.nrsl` files identically to the reference.

## How to get involved

Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the repository, and look for issues labelled `good first issue` to make a first change. For anything that touches the `.nrsl` format, start from the specification in [`packages/spec`](packages/spec).
