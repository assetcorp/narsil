from __future__ import annotations

from chart_paths import figure, languages_bars_chart, languages_chart_dir
from languages_data import PHASES, dig, engines_in, language_label, measurements, phase_summary, thread_counts
from render import and_join, dataset_name, decimal, integer, is_number, table
from sources import Source

MEBIBYTE_BYTES = 1024**2
_RECALL_METRICS = {"recall10": "recall@10", "recall100": "recall@100", "hybridRecall10": "hybrid recall@10"}


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
    median = dig(spread, "median")
    low, high = dig(spread, "min"), dig(spread, "max")
    if not is_number(median):
        return "n/a"
    if not (is_number(low) and is_number(high)) or round(low) == round(high):
        return integer(median)
    return f"{integer(median)} ({integer(low)} to {integer(high)})"


def _repetitions(count: object) -> str:
    if count == 1:
        return "The figures come from a single repetition."
    return f"Rates and memory figures are medians across {integer(count)} repetitions. Latency percentiles pool every measured query. The engine order rotates between repetitions."


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
    threads = and_join([integer(count) for count in thread_counts(results)])
    identities = results.get("engines") or {}
    engine_rows = [
        [
            language_label(engine),
            f"`{dig(identities, engine, 'package')}`",
            str(dig(identities, engine, "version")),
            str(dig(identities, engine, "runtime")),
            str(dig(identities, engine, "build")),
        ]
        for engine in engines_in(results)
    ]
    bullets = [
        f"- **Run.** These figures come from run `{source.run_id}`, recorded on {created[:10]} from commit "
        f"`{commit}`{dirty}. The full tables, with peak memory, are in [the run report]({source.report_link}).",
        f"- **Machine.** {machine_sentence} Its C compiler is {results.get('cCompiler') or 'unknown'}.",
        f"- **Keyword workload.** Keyword search covers {integer(keyword.get('documents'))} documents from BEIR "
        f"{dataset_name(keyword.get('dataset') or '')} with {integer(keyword.get('queries'))} queries drawn from the document text.",
        f"- **Vector workload.** Vector and hybrid search cover {integer(vector.get('documents'))} documents from BEIR "
        f"{dataset_name(vector.get('dataset') or '')} with {integer(vector.get('queries'))} queries, each carrying a "
        f"{integer(vector.get('dimension'))}-dimension `{vector.get('model')}` vector.",
        f"- **Settings.** Every engine returns {integer(settings.get('limit'))} hits, {_storage(settings)}, scores "
        f"them with the {settings.get('metric')} metric, builds its HNSW graph with `m` "
        f"{integer(settings.get('hnswM'))} and `efConstruction` {integer(settings.get('hnswEfConstruction'))}, searches "
        f"it with `efSearch` {integer(settings.get('efSearch'))}, and fuses hybrid results by reciprocal rank with `k` "
        f"{integer(settings.get('rrfK'))}.",
        f"- **Threads.** The suite measures {threads} concurrent callers with the same worker budget. "
        "One caller disables worker copies. TypeScript divides its budget between keyword and vector workers, "
        "Go configures a query pool, and Rust searches on the caller threads.",
        f"- **Repetitions.** {_repetitions(results.get('repetitions'))} Each repetition makes "
        f"{integer(settings.get('warmupPasses'))} warm-up passes over the queries, then "
        f"{integer(passes.get('keyword'))} measured keyword passes, {integer(passes.get('vector'))} vector passes, "
        f"and {integer(passes.get('hybrid'))} hybrid passes.",
    ]
    engines_table = table(["Language", "Package", "Version", "Runtime", "Build"], ["left"] * 5, engine_rows)
    return "\n".join(bullets) + "\n\n" + engines_table


SHARED_MAIN_THREAD_SENTENCE = (
    "Embedded TypeScript sends every search through the one JavaScript main thread, which caps its throughput when "
    "several callers query at once, while the HTTP server answers requests on separate request threads."
)


def _worker_copy_sentences(results: dict) -> str:
    found = measurements(results)
    most = max(thread_counts(results), default=1)
    alone = phase_summary(found, "typescript", "keyword", "keyword", 1)
    shared = phase_summary(found, "typescript", "keyword", "keyword", most)
    mechanism = (
        f"On {integer(most)} threads TypeScript answers through worker copies. Its {integer(most)} callers share the "
        "one Node.js main thread, which copies a query into a message to a free worker thread and copies the answer "
        "back out of its reply, and which answers on its own copy only while every worker is busy. Rust answers on "
        "each caller's thread, and Go hands each query to a free goroutine of its query pool over a channel, so both "
        "search the one index in shared memory and copy neither the query nor the answer."
    )
    if most == 1 or not is_number(dig(alone, "p50Us")) or not is_number(dig(shared, "p50Us")):
        return mechanism
    return (
        f"{mechanism} On 1 thread a TypeScript keyword query takes {_grouped(dig(alone, 'p50Us'), 1)} µs at the "
        f"median. On {integer(most)} threads each query also waits for those two copies and for its turn on the shared "
        f"main thread, and TypeScript's keyword p50 reaches {_grouped(dig(shared, 'p50Us'), 1)} µs while its queries "
        "per second go from "
        f"{integer(dig(alone, 'queriesPerSecond', 'median'))} to {integer(dig(shared, 'queriesPerSecond', 'median'))}. "
        "A worker copy runs the query itself off the main thread, so the application's own code on that thread keeps "
        "running while a search is under way."
    )


def _speed_figure(source: Source, phase: str, title: str) -> str:
    threads = and_join([integer(count) for count in thread_counts(source.data)])
    languages = and_join([language_label(engine) for engine in engines_in(source.data)])
    return figure(
        languages_bars_chart(languages_chart_dir(source.run_id), phase),
        f"{title} in {languages} on {threads} threads: bars for the median queries per second, with the range across "
        "repetitions, beside bars for the p50 latency in microseconds.",
    )


def _speed_block(source: Source) -> str:
    results = source.data
    found = measurements(results)
    chunks: list[str] = [SHARED_MAIN_THREAD_SENTENCE, _worker_copy_sentences(results)]
    for workload, phase, title in PHASES:
        rows = []
        for threads in thread_counts(results):
            for engine in engines_in(results):
                summary = phase_summary(found, engine, workload, phase, threads)
                rows.append([
                    language_label(engine),
                    integer(threads),
                    _spread(dig(summary, "queriesPerSecond")),
                    _grouped(dig(summary, "p50Us"), 1),
                    _grouped(dig(summary, "p99Us"), 1),
                ])
        chunks.append(_speed_figure(source, phase, title))
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
    found = measurements(results)
    rows = []
    for threads in thread_counts(results):
        for engine in engines_in(results):
            keyword, vector = found.get((engine, "keyword", threads)), found.get((engine, "vector", threads))
            rows.append([
                language_label(engine),
                integer(threads),
                _spread(dig(keyword, "load", "documentsPerSecond")),
                _mebibytes(dig(keyword, "memory", "residentBytes")),
                _spread(dig(vector, "load", "documentsPerSecond")),
                _mebibytes(dig(vector, "memory", "residentBytes")),
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
        f"{_RECALL_METRICS.get(widest.get('metric'), widest.get('metric'))}, between {language_label(first)} and "
        f"{language_label(second)}, and the oracle allows up to {decimal(widest.get('bound'), 4)} for that pair."
    )


def _quality_block(source: Source) -> str:
    results = source.data
    found = measurements(results)
    rows = []
    for threads in thread_counts(results):
        for engine in engines_in(results):
            quality = dig(found.get((engine, "vector", threads)), "quality") or {}
            error = quality.get("maxVectorScoreError")
            rows.append([
                language_label(engine),
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
