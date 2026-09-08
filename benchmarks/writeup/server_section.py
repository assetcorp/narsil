"""Build the search-server section of the writeup from the server suite's comparison.

The blocks carry every number, ranking, and figure, so the surrounding prose in
BENCHMARKS.md can stay qualitative and stays in step with the run. Quality metrics
come from `metrics`, throughput from the peak concurrency level the suite records,
the matched-recall operating point from `operating_point`, and every figure from
the charts drawn into the run's own directory.
"""

from __future__ import annotations

from chart_data import (
    BEST_CONFIG,
    EQUAL_PRECISION,
    has_bars,
    has_recall_curve,
    has_sweep,
    has_tail,
    number,
    peak_interval,
    peak_level,
    peak_qps,
    row_label,
    track,
)
from chart_paths import bars_chart, figure, recall_chart, server_chart_dir, sweep_chart, tail_chart
from render import and_join, dataset_name, decimal, engine_name, integer, table
from sources import Source


def _date(source: Source) -> str:
    created = source.manifest.get("created_at") or ""
    return created[:10] if isinstance(created, str) else ""


def _engine(engines: list[dict], name: str) -> dict | None:
    return next((engine for engine in engines if engine.get("name") == name), None)


def _narsil_row(rows: list[dict]) -> dict | None:
    return next((row for row in rows if row.get("engine") == "narsil"), None)


def _metric(row: dict | None, key: str) -> float | None:
    return number(((row or {}).get("metrics") or {}).get(key))


def _client_bound(row: dict) -> bool:
    peak = peak_level(row)
    return bool(peak and peak.get("client_bound"))


def _qps_cell(row: dict) -> str:
    cell = integer(peak_qps(row))
    interval = peak_interval(row)
    if interval is not None and interval[0] != interval[1]:
        cell += f" ({integer(interval[0])} to {integer(interval[1])})"
    if _client_bound(row):
        cell += " (client-limited)"
    return cell


def _quality_table(rows: list[dict], profile: str) -> str:
    if not _judged(rows):
        ordered = sorted(rows, key=lambda row: peak_qps(row) or -1.0, reverse=True)
        body = [[row_label(row, profile), _qps_cell(row)] for row in ordered]
        return table(["Engine", "Peak QPS"], ["left", "right"], body)
    ordered = sorted(rows, key=lambda row: _metric(row, "ndcg_cut_10") or -1.0, reverse=True)
    body = [
        [
            row_label(row, profile),
            decimal(_metric(row, "ndcg_cut_10"), 4),
            decimal(_metric(row, "recall_100"), 4),
            decimal(_metric(row, "map"), 4),
            decimal(_metric(row, "recip_rank"), 4),
            _qps_cell(row),
        ]
        for row in ordered
    ]
    headers = ["Engine", "nDCG@10", "Recall@100", "MAP", "MRR", "Peak QPS"]
    return table(headers, ["left", "right", "right", "right", "right", "right"], body)


def _vector_table(rows: list[dict], profile: str) -> str:
    ordered = sorted(rows, key=lambda row: peak_qps(row) or -1.0, reverse=True)
    body = []
    for row in ordered:
        point = row.get("operating_point") or {}
        knob = point.get("knob")
        value = point.get("chosen_value")
        knob_cell = f"{knob} {value}" if knob is not None and value is not None else "n/a"
        body.append([row_label(row, profile), knob_cell, decimal(point.get("achieved_recall"), 4), _qps_cell(row)])
    headers = ["Engine", "Search effort", "ANN recall@10", "Peak QPS"]
    return table(headers, ["left", "left", "right", "right"], body)


def _bars_figure(chart_dir: str, profile: str, name: str, dataset_id: str, rows: list[dict]) -> str | None:
    if not has_bars(rows):
        return None
    dataset = dataset_name(dataset_id)
    if not _judged(rows):
        return figure(
            bars_chart(chart_dir, profile, name, dataset_id),
            f"One bar panel for the {name} track on {dataset}: peak queries per second per engine with a 95% "
            "confidence interval across passes.",
        )
    return figure(
        bars_chart(chart_dir, profile, name, dataset_id),
        f"Two bar panels for the {name} track on {dataset}: nDCG@10 per engine, and peak queries per second per "
        "engine with a 95% confidence interval across passes.",
    )


def _sweep_figure(chart_dir: str, profile: str, name: str, dataset_id: str, rows: list[dict]) -> str | None:
    if not has_sweep(rows):
        return None
    dataset = dataset_name(dataset_id)
    return figure(
        sweep_chart(chart_dir, profile, name, dataset_id),
        f"Line panels for the {name} track on {dataset} against concurrent clients: queries per second with a "
        "confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report "
        "their own query time, and the engine container's busy cores where the run recorded them.",
    )


def _tail_figure(chart_dir: str, profile: str, name: str, datasets: list[dict]) -> str | None:
    if not has_tail(datasets):
        return None
    return figure(
        tail_chart(chart_dir, profile, name),
        f"Server-side latency at p50, p95, p99, p99.9, and the maximum for each engine on the {name} track at its "
        "peak concurrency level, one panel per dataset, on a logarithmic scale. An engine that reports no "
        "server-side time is absent, and a whole-millisecond timer leaves out the points it floors to zero.",
    )


def _recall_figure(chart_dir: str, dataset_id: str, comparisons: dict[str, dict | None]) -> str | None:
    if not has_recall_curve(comparisons, dataset_id):
        return None
    return figure(
        recall_chart(chart_dir, dataset_id),
        f"Queries per second against ANN recall@10 on {dataset_name(dataset_id)}, one point per search-effort "
        "level per engine, with equal precision drawn solid and recommended production settings dashed.",
    )


def _track_block(source: Source, profile: str, name: str, render_table, comparisons: dict[str, dict | None]) -> str:
    entry = track(comparisons[profile], name)
    if entry is None:
        return f"No {name} results were recorded."
    chart_dir = server_chart_dir(source.run_id)
    chunks: list[str] = []
    for dataset in entry["datasets"]:
        dataset_id = dataset["dataset_id"]
        rows = dataset["rows"]
        label = dataset_name(dataset_id)
        chunks.append(f"**{label}.**")
        bars = _bars_figure(chart_dir, profile, name, dataset_id, rows)
        if bars:
            chunks.append(bars)
        chunks.append(render_table(rows, profile))
        sweep = _sweep_figure(chart_dir, profile, name, dataset_id, rows)
        if sweep:
            chunks.append(sweep)
        if name == "vector":
            recall = _recall_figure(chart_dir, dataset_id, comparisons) if profile == EQUAL_PRECISION else None
            if recall:
                chunks.append(recall)
    tail = _tail_figure(chart_dir, profile, name, entry["datasets"])
    if tail:
        chunks.append(tail)
    return "\n\n".join(chunks)


def _judged(rows: list[dict]) -> bool:
    return any(_metric(row, "ndcg_cut_10") is not None for row in rows)


def _vector_intro(comparison: dict, config: dict) -> str:
    target = decimal(config.get("recall_target"), 2)
    sentences = []
    for dataset in (track(comparison, "vector") or {"datasets": []})["datasets"]:
        rows = dataset["rows"]
        narsil = _narsil_row(rows)
        opening = (
            f"On {dataset_name(dataset['dataset_id'])}, every engine tunes its search effort to reach ann_recall@10 "
            f"of at least {target} against the exact neighbours"
        )
        if not _judged(rows):
            sentences.append(
                f"{opening}. The set carries no relevance judgements, so it reports recall, latency, and "
                "throughput and no ranking quality."
            )
            continue
        ndcg = decimal(_metric(narsil, "ndcg_cut_10"), 4) if narsil else "n/a"
        recall = decimal(_metric(narsil, "recall_100"), 4) if narsil else "n/a"
        sentences.append(
            f"{opening}, and each returns the same ranking, so nDCG@10 is {ndcg} and Recall@100 is {recall} "
            "across the field."
        )
    return " ".join(sentences)


def _dataset_phrases(track_entry: dict) -> list[str]:
    phrases = []
    for dataset in track_entry["datasets"]:
        rows = dataset["rows"]
        row = _narsil_row(rows) or (rows[0] if rows else {})
        docs = (row.get("operational") or {}).get("documents_indexed")
        phrases.append(f"{dataset_name(dataset['dataset_id'])} ({integer(docs)} documents)")
    return phrases


def _vectors_sentence(config: dict) -> str:
    vectors = config.get("dataset_vectors") or {}
    if not vectors:
        return ""
    phrases = []
    for dataset_id, entry in vectors.items():
        provenance = (
            "read from a published dataset artifact pinned by its SHA-256"
            if entry.get("source") == "artifact"
            else "loaded and hash-verified through `ir_datasets`"
        )
        phrases.append(
            f"{dataset_name(dataset_id)} is {provenance}, with {entry.get('model')} vectors at "
            f"{integer(entry.get('dims'))} dimensions"
        )
    return " " + "; ".join(phrases) + "."


def _threads_sentence(narsil: dict) -> str:
    setup = narsil.get("server_setup") or {}
    workers = setup.get("worker_threads")
    request_threads = setup.get("request_threads")
    scaled_out = setup.get("scaled_out_indexes")
    if not isinstance(workers, int) or not isinstance(request_threads, int) or not isinstance(scaled_out, list):
        return "This run recorded no worker copy configuration for Narsil."
    copies = (
        "the benchmark index scaled out across them"
        if scaled_out
        else "no index scaled out across them, so the main copy answered every query"
    )
    return (
        f"Narsil started at the engine defaults, and its memory stats report {integer(workers)} worker threads, "
        f"{integer(request_threads)} request threads receiving requests, and {copies}."
    )


def _load_sentence(config: dict) -> str:
    throughput = config.get("throughput") or {}
    levels = throughput.get("concurrency") or []
    passes = throughput.get("passes")
    if not levels:
        return "The run recorded no concurrency sweep."
    level_text = and_join([integer(level) for level in levels])
    if isinstance(passes, int) and passes > 1:
        return (
            f"The harness measured throughput at {level_text} concurrent clients, one pass per level and "
            f"{integer(passes)} passes at each engine's peak level, and the tables report the median peak pass "
            "with a 95% bootstrap interval."
        )
    return f"The harness measured throughput at {level_text} concurrent clients, one pass per level."


def _setup_block(source: Source) -> str:
    comparison = source.data
    config = comparison.get("config") or {}
    environment = comparison.get("environment") or {}
    engines = comparison.get("engines") or []
    keyword = track(comparison, "keyword") or {"datasets": []}

    narsil = _engine(engines, "narsil") or {}
    build = narsil.get("build_identity") or {}
    commit = (build.get("build_hash") or "")[:12] or "unknown"
    dirty = ", which sits ahead of the released version" if build.get("dirty") else ""
    others = [
        f"{engine_name(engine['name'])} {engine.get('version') or 'n/a'}"
        for engine in engines
        if engine.get("name") != "narsil"
    ]

    cap = decimal((config.get("memory_cap_bytes") or 0) / 1e9, 1)
    narsil_version = build.get("version") or narsil.get("version") or "n/a"
    machine_label = environment.get("machine_label")
    host = (
        f"{environment.get('cpu_model') or 'an unspecified CPU'} and "
        f"{environment.get('os')} {environment.get('arch')}"
    )
    machine = (
        f"The run executed on {machine_label}, which reports {host}."
        if machine_label
        else f"The run host reports {host}."
    )

    return "\n".join([
        f"- **Run.** These figures come from run `{source.run_id}`, recorded on {_date(source)} from commit "
        f"`{commit}`{dirty}. The raw per-engine results and the full comparison are in "
        f"[the run report]({source.report_link}).",
        f"- **Datasets.** The run covers {and_join(_dataset_phrases(keyword))}.{_vectors_sentence(config)}",
        f"- **Engines.** The comparison runs Narsil {narsil_version} against {and_join(others)}, "
        "and every engine runs from a pinned image.",
        f"- **Equal conditions.** Every engine receives the same {cap} GB memory cap, the same run depth of "
        f"{integer(config.get('run_depth'))}, and the same run-file ordering, and the engines run one at a time so "
        "latency never contends.",
        f"- **Load.** {_load_sentence(config)}",
        f"- **Narsil threads.** {_threads_sentence(narsil)}",
        f"- **Machine.** {machine}",
        f"- **BM25 calibration.** Narsil indexes each corpus with BM25 k1={config.get('k1')} and b={config.get('b')}, "
        "the Anserini reference configuration.",
    ])


def server_blocks(source: Source, best: Source | None) -> dict[str, str]:
    comparison = source.data
    config = comparison.get("config") or {}
    comparisons = {EQUAL_PRECISION: comparison, BEST_CONFIG: best.data if best is not None else None}
    blocks = {
        "server-setup": _setup_block(source),
        "server-keyword": _track_block(source, EQUAL_PRECISION, "keyword", _quality_table, comparisons),
        "server-vector": "\n\n".join([
            _vector_intro(comparison, config),
            _track_block(source, EQUAL_PRECISION, "vector", _vector_table, comparisons),
        ]),
        "server-hybrid": _track_block(source, EQUAL_PRECISION, "hybrid", _quality_table, comparisons),
    }
    if best is None:
        absent = "This run recorded no pass under each engine's recommended production settings."
        blocks["server-vector-best-config"] = absent
        blocks["server-hybrid-best-config"] = absent
    else:
        blocks["server-vector-best-config"] = _track_block(source, BEST_CONFIG, "vector", _vector_table, comparisons)
        blocks["server-hybrid-best-config"] = _track_block(source, BEST_CONFIG, "hybrid", _quality_table, comparisons)
    return blocks
