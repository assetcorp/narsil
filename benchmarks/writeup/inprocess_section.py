"""Build the embedded (in-process) section of the writeup from the in-process results.

The in-process suite records one `results.json` per run rather than a comparison
document, so the values here read straight from its tier objects: `tiers.textOnly`
for indexing and query speed, `relevanceQuality` for ranking, and `vectorRelevance`
for the embedded vector index.
"""

from __future__ import annotations

from render import and_join, bar_chart, dataset_name, decimal, engine_name, integer, is_number, percent, table
from sources import Source

_ENGINE_ORDER = ["narsil", "orama", "minisearch"]
_VECTOR_ENGINE_ORDER = ["narsil", "orama"]


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
    dirty = ", with uncommitted changes" if git.get("dirty") else ""
    host = (
        f"{environment.get('cpu') or 'an unspecified CPU'}, {environment.get('totalMemory')} of memory, "
        f"Node.js {environment.get('node')}, and {environment.get('os')} {environment.get('arch')}"
    )
    label = environment.get("machineLabel")
    machine = (
        f"The run executed on {label}, which reports {host}." if label else f"The run host reports {host}."
    )
    scales = and_join([integer(scale) for scale in (config.get("scales") or [])])

    return "\n".join([
        f"- **Run.** These figures come from run `{source.run_id}`, recorded on {_date(source)} from commit "
        f"`{commit}`{dirty}. The full per-scale tables are in [the run report]({source.report_link}).",
        f"- **Engines.** The comparison runs Narsil {engines.get('narsil') or 'n/a'} against Orama "
        f"{engines.get('orama') or 'n/a'} and MiniSearch {engines.get('minisearch') or 'n/a'}, all inside one "
        "Node.js process.",
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

    entries = []
    for engine in order:
        value = _quality(results, engine, "meanNdcg10")
        if value is not None:
            entries.append((engine_name(engine), value, decimal(value, 4)))

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
        f"Ranking quality on BEIR {name}, nDCG@10, higher is better:",
        bar_chart(entries),
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

    insert_entries = []
    for engine in order:
        value = _tier_value(results, "textOnly", engine, top_scale, "insertDocsPerSec")
        if value is not None:
            insert_entries.append((engine_name(engine), value, f"{integer(value)} docs/s"))

    return "\n\n".join([
        f"Insert throughput at {top_label} documents, documents per second, higher is better:",
        bar_chart(insert_entries),
        "Insert throughput at each scale, documents per second:",
        _scale_table(results, order, config, "textOnly", ("insertDocsPerSec",), 0),
        "Search latency at each scale, p50 milliseconds:",
        _scale_table(results, order, config, "textOnly", ("searchLatency", "p50Ms"), 3),
        "Resident memory at each scale, megabytes:",
        _scale_table(results, order, config, "textOnly", ("memoryMb",), 1),
        f"Filtered search latency at {top_label} documents, p50 milliseconds:",
        _filtered_table(results, order, top_scale),
    ])


def _vector_block(source: Source) -> str:
    results = source.data
    config = results.get("config") or {}
    order = _present(results, _VECTOR_ENGINE_ORDER)
    vector = results.get("vectorRelevance") or {}

    chunks: list[str] = []
    for dataset in config.get("vectorDatasets") or []:
        body = []
        for engine in order:
            record = (vector.get(engine) or {}).get(dataset) or {}
            body.append([
                engine_name(engine),
                percent(record.get("meanRecallAt10")),
                integer(record.get("insertDocsPerSec")),
                decimal(_dig(record, "searchLatency", "p50Ms"), 3),
                decimal(record.get("memoryMb"), 1),
            ])
        headers = ["Engine", "Recall@10", "Insert docs/s", "Search p50 ms", "Memory MB"]
        chunks.append(f"Embedded vector search on BEIR {dataset_name(dataset)}:")
        chunks.append(table(headers, ["left", "right", "right", "right", "right"], body))
    return "\n\n".join(chunks)


def inprocess_blocks(source: Source) -> dict[str, str]:
    return {
        "inprocess-setup": _setup_block(source),
        "inprocess-quality": _quality_block(source),
        "inprocess-speed": _speed_block(source),
        "inprocess-vector": _vector_block(source),
    }
