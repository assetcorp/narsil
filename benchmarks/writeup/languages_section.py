from __future__ import annotations

from render import and_join, dataset_name, decimal, integer, is_number, table
from sources import Source

MEBIBYTE_BYTES = 1024**2
_ENGINE_ORDER = ["typescript", "rust", "go"]
_ENGINE_LABELS = {"typescript": "TypeScript", "rust": "Rust", "go": "Go"}
_PHASES = [("keyword", "keyword", "Keyword search"), ("vector", "vector", "Vector search"), ("vector", "hybrid", "Hybrid search")]
_RECALL_METRICS = {"recall10": "recall@10", "recall100": "recall@100", "hybridRecall10": "hybrid recall@10"}


def _label(engine: str) -> str:
    return _ENGINE_LABELS.get(engine, engine)


def _dig(node: object, *path: str) -> object:
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def _measurements(results: dict) -> dict[tuple[str, str, int], dict]:
    found: dict[tuple[str, str, int], dict] = {}
    for entry in results.get("measurements") or []:
        if isinstance(entry, dict):
            found[(entry.get("engine"), entry.get("workload"), entry.get("threads"))] = entry
    return found


def _engines(results: dict) -> list[str]:
    present = results.get("engines") or {}
    return [engine for engine in _ENGINE_ORDER if engine in present]


def _threads(results: dict) -> list[int]:
    return [count for count in results.get("threadCounts") or [] if isinstance(count, int)]


def _grouped(value: object, places: int) -> str:
    return f"{value:,.{places}f}" if is_number(value) else "n/a"


def _mebibytes(value: object) -> str:
    return _grouped(value / MEBIBYTE_BYTES, 1) if is_number(value) else "n/a"


def _storage(settings: dict) -> str:
    quantization = settings.get("quantization")
    if quantization == "none":
        return "stores every vector as float32 with no quantization"
    return f"stores vectors with {quantization} quantization"


def _spread(spread: object) -> str:
    median = _dig(spread, "median")
    low, high = _dig(spread, "min"), _dig(spread, "max")
    if not is_number(median):
        return "n/a"
    if not (is_number(low) and is_number(high)) or round(low) == round(high):
        return integer(median)
    return f"{integer(median)} ({integer(low)} to {integer(high)})"


def _repetitions(count: object) -> str:
    if count == 1:
        return "The figures come from a single repetition."
    return f"The figures are the median of {integer(count)} repetitions, and the engine order rotates between them."


def _setup_block(source: Source) -> str:
    results = source.data
    machine = results.get("machine") or {}
    workload = results.get("workload") or {}
    keyword, vector = workload.get("keyword") or {}, workload.get("vector") or {}
    settings = workload.get("settings") or {}
    passes = settings.get("measuredPasses") or {}
    git = source.manifest.get("git") or {}
    commit = (git.get("commit") or "")[:12] or "unknown"
    dirty = ", with changes that were not yet committed" if git.get("dirty") else ""
    created = results.get("createdAt") or ""
    host = (
        f"{machine.get('cpu') or 'an unspecified CPU'} with {integer(machine.get('logicalCpus'))} logical CPUs, "
        f"{machine.get('totalMemory')} of memory, and {machine.get('os')} {machine.get('arch')}"
    )
    label = machine.get("machineLabel")
    machine_sentence = f"{label} hosted this run, and it reports {host}." if label else f"The host reports {host}."
    threads = and_join([integer(count) for count in _threads(results)])
    identities = results.get("engines") or {}
    engine_rows = [
        [
            _label(engine),
            f"`{_dig(identities, engine, 'package')}`",
            str(_dig(identities, engine, "version")),
            str(_dig(identities, engine, "runtime")),
            str(_dig(identities, engine, "build")),
        ]
        for engine in _engines(results)
    ]
    bullets = [
        f"- **Run.** These figures come from run `{source.run_id}`, recorded on {created[:10]} from commit "
        f"`{commit}`{dirty}. The full tables, with peak memory, are in [the run report]({source.report_link}).",
        f"- **Machine.** {machine_sentence} Its C compiler is {results.get('cCompiler') or 'unknown'}.",
        f"- **Keyword workload.** Keyword search covers {integer(keyword.get('documents'))} documents from BEIR "
        f"{dataset_name(keyword.get('dataset') or '')} with {integer(keyword.get('queries'))} of its queries.",
        f"- **Vector workload.** Vector and hybrid search cover {integer(vector.get('documents'))} documents from BEIR "
        f"{dataset_name(vector.get('dataset') or '')} with {integer(vector.get('queries'))} queries, each carrying a "
        f"{integer(vector.get('dimension'))}-dimension `{vector.get('model')}` vector.",
        f"- **Settings.** Every engine returns {integer(settings.get('limit'))} hits, {_storage(settings)}, scores "
        f"them with the {settings.get('metric')} metric, builds its HNSW graph with `m` "
        f"{integer(settings.get('hnswM'))} and `efConstruction` {integer(settings.get('hnswEfConstruction'))}, searches "
        f"it with `efSearch` {integer(settings.get('efSearch'))}, and fuses hybrid results by reciprocal rank with `k` "
        f"{integer(settings.get('rrfK'))}.",
        f"- **Threads.** The suite measures {threads} threads. On 1 thread every engine turns its worker copies off. "
        "On more threads the suite sets every engine's worker count to the thread count, and that many callers query "
        "the engine at once.",
        f"- **Repetitions.** {_repetitions(results.get('repetitions'))} Each repetition makes "
        f"{integer(settings.get('warmupPasses'))} warm-up passes over the queries, then "
        f"{integer(passes.get('keyword'))} measured keyword passes, {integer(passes.get('vector'))} vector passes, "
        f"and {integer(passes.get('hybrid'))} hybrid passes.",
    ]
    engines_table = table(["Language", "Package", "Version", "Runtime", "Build"], ["left"] * 5, engine_rows)
    return "\n".join(bullets) + "\n\n" + engines_table


def _speed_block(source: Source) -> str:
    results = source.data
    found = _measurements(results)
    chunks: list[str] = []
    for workload, phase, title in _PHASES:
        rows = []
        for threads in _threads(results):
            for engine in _engines(results):
                summary = _dig(found.get((engine, workload, threads)), "phases", phase)
                rows.append([
                    _label(engine),
                    integer(threads),
                    _spread(_dig(summary, "queriesPerSecond")),
                    _grouped(_dig(summary, "p50Us"), 1),
                    _grouped(_dig(summary, "p99Us"), 1),
                ])
        chunks.append(f"{title}, with queries per second as the median and the range across repetitions:")
        chunks.append(
            table(
                ["Language", "Threads", "Queries per second", "p50 µs", "p99 µs"],
                ["left", "right", "right", "right", "right"],
                rows,
            )
        )
    return "\n\n".join(chunks)


def _load_block(source: Source) -> str:
    results = source.data
    found = _measurements(results)
    rows = []
    for threads in _threads(results):
        for engine in _engines(results):
            keyword, vector = found.get((engine, "keyword", threads)), found.get((engine, "vector", threads))
            rows.append([
                _label(engine),
                integer(threads),
                _spread(_dig(keyword, "load", "documentsPerSecond")),
                _mebibytes(_dig(keyword, "memory", "residentBytes")),
                _spread(_dig(vector, "load", "documentsPerSecond")),
                _mebibytes(_dig(vector, "memory", "residentBytes")),
            ])
    headers = ["Language", "Threads", "Keyword docs/s", "Keyword MiB", "Vector docs/s", "Vector MiB"]
    return "\n\n".join([
        "Loading speed and the resident memory of the process once it holds the whole corpus:",
        table(headers, ["left", *["right"] * 5], rows),
    ])


def _agreement_sentence(results: dict) -> str:
    comparisons = [entry for entry in results.get("crossEngine") or [] if is_number(entry.get("meanDifference"))]
    if not comparisons:
        return "The run recorded no comparison between engines."
    widest = max(comparisons, key=lambda entry: abs(entry["meanDifference"]))
    first, second = (widest.get("engines") or ["", ""])[:2]
    return (
        f"The widest gap between two engines is {decimal(abs(widest['meanDifference']), 4)} in mean "
        f"{_RECALL_METRICS.get(widest.get('metric'), widest.get('metric'))}, between {_label(first)} and "
        f"{_label(second)}, and the oracle allows up to {decimal(widest.get('bound'), 4)} for that pair."
    )


def _quality_block(source: Source) -> str:
    results = source.data
    found = _measurements(results)
    rows = []
    for threads in _threads(results):
        for engine in _engines(results):
            quality = _dig(found.get((engine, "vector", threads)), "quality") or {}
            error = quality.get("maxVectorScoreError")
            rows.append([
                _label(engine),
                integer(threads),
                decimal(quality.get("recall10"), 4),
                decimal(quality.get("recall100"), 4),
                decimal(quality.get("hybridRecall10"), 4),
                f"{error:.1e}" if is_number(error) else "n/a",
            ])
    headers = ["Language", "Threads", "Recall@10", "Recall@100", "Hybrid recall@10", "Largest score error"]
    return "\n\n".join([
        table(headers, ["left", *["right"] * 5], rows),
        _agreement_sentence(results),
    ])


def languages_blocks(source: Source) -> dict[str, str]:
    return {
        "languages-setup": _setup_block(source),
        "languages-speed": _speed_block(source),
        "languages-load": _load_block(source),
        "languages-quality": _quality_block(source),
    }
