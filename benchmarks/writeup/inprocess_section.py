"""Build the embedded (in-process) section of the writeup from the in-process results.

The in-process suite records one `results.json` per run and no comparison
document, so the values here come straight from its tier objects: `tiers.textOnly`
for indexing and query speed, `relevanceQuality` for ranking, and `vectorRelevance`
for the embedded vector index.
"""

from __future__ import annotations

from chart_paths import embedded_scale_chart, figure, inprocess_chart_dir
from render import and_join, dataset_name, decimal, engine_name, integer, is_number, percent, table
from sources import Source

_ENGINE_ORDER = ["narsil", "orama", "minisearch"]
_VECTOR_ENGINE_ORDER = ["narsil", "orama"]
_MEMORY_KEY = "heapAndExternalMb"


def _date(source: Source) -> str:
    created = source.manifest.get("createdAt") or ""
    return created[:10] if isinstance(created, str) else ""


def _present(results: dict, order: list[str]) -> list[str]:
    engines = results.get("engines") or {}
    return [name for name in order if name in engines]


def _dig(node: object, *path: str) -> float | None:
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return float(node) if is_number(node) else None


def _quality(results: dict, engine: str, key: str) -> float | None:
    return _dig(results.get("relevanceQuality") or {}, engine, key)


def _scale_keys(config: dict) -> list[str]:
    return [str(scale) for scale in (config.get("scales") or [])]


def _tier_value(results: dict, tier: str, engine: str, scale: str, *path: str) -> float | None:
    node = (((results.get("tiers") or {}).get(tier) or {}).get(engine) or {}).get(scale)
    return _dig(node, *path)


def _setup_block(source: Source) -> str:
    results = source.data
    config = results.get("config") or {}
    engines = results.get("engines") or {}
    environment = source.manifest.get("environment") or {}
    git = source.manifest.get("git") or {}
    dataset = results.get("relevanceDataset") or {}

    commit = (git.get("commit") or "")[:12] or "unknown"
    dirty = ", which sits ahead of the released version" if git.get("dirty") else ""
    host = (
        f"{environment.get('cpu') or 'an unspecified CPU'}, {environment.get('totalMemory')} of memory, "
        f"Node.js {environment.get('node')}, and {environment.get('os')} {environment.get('arch')}"
    )
    label = environment.get("machineLabel")
    machine = (
        f"{label} hosted this run, and it reports {host}." if label else f"The host reports {host}."
    )
    scales = and_join([integer(scale) for scale in (config.get("scales") or [])])

    return "\n".join([
        f"- **Run.** These figures come from run `{source.run_id}`, recorded on {_date(source)} from commit "
        f"`{commit}`{dirty}. The full per-scale tables are in [the run report]({source.report_link}).",
        f"- **Engines.** The comparison runs Narsil {engines.get('narsil') or 'n/a'} against Orama "
        f"{engines.get('orama') or 'n/a'} and MiniSearch {engines.get('minisearch') or 'n/a'}, all inside one "
        "Node.js process.",
        "- **Threads.** Every engine answers on one thread. Narsil runs with `workers.enabled` off, so it holds "
        "no worker copies here, and the server comparison above is where its worker threads take part.",
        f"- **Machine.** {machine}",
        f"- **Speed corpus.** The indexing and query tiers run on BEIR {dataset_name(config.get('dataSource') or '')}, "
        f"{integer(config.get('perfCorpusDocCount'))} documents, measured at {scales} documents.",
        f"- **Relevance dataset.** Ranking quality is scored on BEIR {dataset_name(dataset.get('name') or '')}, "
        f"{integer(dataset.get('documents'))} documents and {integer(dataset.get('queries'))} judged queries, "
        f"verified by archive checksum `{(dataset.get('archiveSha256') or '')[:12]}`.",
    ])


def _quality_block(source: Source) -> str:
    results = source.data
    order = _present(results, _ENGINE_ORDER)
    name = dataset_name((results.get("relevanceDataset") or {}).get("name") or "")

    ordered = sorted(order, key=lambda engine: _quality(results, engine, "meanNdcg10") or -1.0, reverse=True)
    body = [
        [
            engine_name(engine),
            decimal(_quality(results, engine, "meanNdcg10"), 4),
            decimal(_quality(results, engine, "meanPrecision10"), 4),
            decimal(_quality(results, engine, "meanMap"), 4),
            decimal(_quality(results, engine, "meanMrr"), 4),
        ]
        for engine in ordered
    ]
    headers = ["Engine", "nDCG@10", "P@10", "MAP", "MRR"]
    return "\n\n".join([
        f"Ranking quality on BEIR {name}, higher is better:",
        table(headers, ["left", "right", "right", "right", "right"], body),
    ])


def _scale_table(results: dict, order: list[str], config: dict, tier: str, path: tuple[str, ...], places: int) -> str:
    scale_keys = _scale_keys(config)
    headers = ["Engine", *[integer(int(scale)) for scale in scale_keys]]
    body = []
    for engine in order:
        cells = [engine_name(engine)]
        for scale in scale_keys:
            value = _tier_value(results, tier, engine, scale, *path)
            cells.append(integer(value) if places == 0 else decimal(value, places))
        body.append(cells)
    return table(headers, ["left", *["right"] * len(scale_keys)], body)


def _filtered_table(results: dict, order: list[str], top_scale: str) -> str:
    body = []
    for engine in order:
        value = _tier_value(results, "fullSchema", engine, top_scale, "filteredLatency", "p50Ms")
        body.append([engine_name(engine), decimal(value, 3) if value is not None else "not supported"])
    return table(["Engine", "Filtered search p50 ms"], ["left", "right"], body)


def _speed_block(source: Source) -> str:
    results = source.data
    config = results.get("config") or {}
    order = _present(results, _ENGINE_ORDER)
    scale_keys = _scale_keys(config)
    top_scale = scale_keys[-1] if scale_keys else ""
    top_label = integer(int(top_scale)) if top_scale else "n/a"

    chunks = [
        figure(
            embedded_scale_chart(inprocess_chart_dir(source.run_id)),
            "Line panels for the embedded engines across corpus size: insert documents per second, search p50 "
            "latency on a logarithmic scale, and, where the suite recorded it, heap plus external memory.",
        ),
        "Insert throughput at each scale, documents per second:",
        _scale_table(results, order, config, "textOnly", ("insertDocsPerSec",), 0),
        "Search latency at each scale, p50 milliseconds:",
        _scale_table(results, order, config, "textOnly", ("searchLatency", "p50Ms"), 3),
    ]
    if _records_memory(results, order, scale_keys):
        chunks.append("Heap plus external memory at each scale, megabytes:")
        chunks.append(_scale_table(results, order, config, "textOnly", (_MEMORY_KEY,), 1))
    else:
        chunks.append("The suite recorded no memory figure under the heap plus external definition in this run.")
    chunks.append(f"Filtered search latency at {top_label} documents, p50 milliseconds:")
    chunks.append(_filtered_table(results, order, top_scale))
    return "\n\n".join(chunks)


def _records_memory(results: dict, order: list[str], scale_keys: list[str]) -> bool:
    return any(
        _tier_value(results, "textOnly", engine, scale, _MEMORY_KEY) is not None
        for engine in order
        for scale in scale_keys
    )


def _vector_block(source: Source) -> str:
    results = source.data
    config = results.get("config") or {}
    order = _present(results, _VECTOR_ENGINE_ORDER)
    vector = results.get("vectorRelevance") or {}

    chunks: list[str] = []
    for dataset in config.get("vectorDatasets") or []:
        records = {engine: (vector.get(engine) or {}).get(dataset) or {} for engine in order}
        with_memory = any(is_number(record.get(_MEMORY_KEY)) for record in records.values())
        body = []
        for engine in order:
            record = records[engine]
            cells = [
                engine_name(engine),
                percent(record.get("meanRecallAt10")),
                integer(record.get("insertDocsPerSec")),
                decimal(_dig(record, "searchLatency", "p50Ms"), 3),
            ]
            if with_memory:
                cells.append(decimal(record.get(_MEMORY_KEY), 1))
            body.append(cells)
        headers = ["Engine", "Recall@10", "Insert docs/s", "Search p50 ms"]
        if with_memory:
            headers.append("Heap plus external MB")
        chunks.append(f"Embedded vector search on BEIR {dataset_name(dataset)}:")
        chunks.append(table(headers, ["left", *["right"] * (len(headers) - 1)], body))
    return "\n\n".join(chunks)


def inprocess_blocks(source: Source) -> dict[str, str]:
    return {
        "inprocess-setup": _setup_block(source),
        "inprocess-quality": _quality_block(source),
        "inprocess-speed": _speed_block(source),
        "inprocess-vector": _vector_block(source),
    }
