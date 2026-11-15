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
    recall_unrecorded,
    row_label,
    track,
)
from chart_paths import bars_chart, figure, recall_chart, server_chart_dir, sweep_chart, tail_chart
from narsil_servers import DISPLAY_NAME_FIELD, NOT_MEASURED_TEXT, is_unmeasured, narsil_row
from render import dataset_name, decimal, integer, table
from server_setup import setup_block
from sources import Source


def _measured_first(rows: list[dict], key) -> list[dict]:
    measured = sorted((row for row in rows if not is_unmeasured(row)), key=key, reverse=True)
    return [*measured, *(row for row in rows if is_unmeasured(row))]


def _unmeasured_cells(row: dict, profile: str, columns: int) -> list[str]:
    return [row_label(row, profile), *([NOT_MEASURED_TEXT] * columns)]


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
    if DISPLAY_NAME_FIELD in row and (row.get("operating_point") or {}).get("met_target") is False:
        cell += " (below recall target)"
    elif DISPLAY_NAME_FIELD in row and recall_unrecorded(row):
        cell += " (recall not recorded)"
    return cell


def _quality_cells(row: dict, profile: str) -> list[str]:
    if is_unmeasured(row):
        return _unmeasured_cells(row, profile, 5)
    return [
        row_label(row, profile),
        decimal(_metric(row, "ndcg_cut_10"), 4),
        decimal(_metric(row, "recall_100"), 4),
        decimal(_metric(row, "map"), 4),
        decimal(_metric(row, "recip_rank"), 4),
        _qps_cell(row),
    ]


def _quality_table(rows: list[dict], profile: str) -> str:
    if not _judged(rows):
        ordered = _measured_first(rows, lambda row: peak_qps(row) or -1.0)
        body = [
            _unmeasured_cells(row, profile, 1) if is_unmeasured(row) else [row_label(row, profile), _qps_cell(row)]
            for row in ordered
        ]
        return table(["Engine", "Peak QPS"], ["left", "right"], body)
    ordered = _measured_first(rows, lambda row: _metric(row, "ndcg_cut_10") or -1.0)
    body = [_quality_cells(row, profile) for row in ordered]
    headers = ["Engine", "nDCG@10", "Recall@100", "MAP", "MRR", "Peak QPS"]
    return table(headers, ["left", "right", "right", "right", "right", "right"], body)


def _vector_table(rows: list[dict], profile: str) -> str:
    ordered = _measured_first(rows, lambda row: peak_qps(row) or -1.0)
    body = []
    for row in ordered:
        if is_unmeasured(row):
            body.append(_unmeasured_cells(row, profile, 3))
            continue
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
        "their own query time, and the engine container's busy cores where the harness recorded them.",
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
        narsil = narsil_row(rows)
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
        measured = [row for row in rows if not is_unmeasured(row)]
        same_ranking = narsil is not None and all(
            _metric(narsil, key) is not None and _metric(row, key) == _metric(narsil, key)
            for row in measured for key in ("ndcg_cut_10", "recall_100")
        )
        if not same_ranking or any(DISPLAY_NAME_FIELD in row for row in rows):
            sentences.append(f"{opening}. The tables report each engine's measured ranking quality.")
            continue
        sentences.append(
            f"{opening}, and each returns the same ranking, so nDCG@10 is {ndcg} and Recall@100 is {recall} "
            "across the field."
        )
    return " ".join(sentences)


def server_blocks(source: Source, best: Source | None) -> dict[str, str]:
    comparison = source.data
    config = comparison.get("config") or {}
    comparisons = {EQUAL_PRECISION: comparison, BEST_CONFIG: best.data if best is not None else None}
    blocks = {
        "server-setup": setup_block(source),
        "server-keyword": _track_block(source, EQUAL_PRECISION, "keyword", _quality_table, comparisons),
        "server-vector": "\n\n".join([
            _vector_intro(comparison, config),
            _track_block(source, EQUAL_PRECISION, "vector", _vector_table, comparisons),
        ]),
        "server-hybrid": _track_block(source, EQUAL_PRECISION, "hybrid", _quality_table, comparisons),
    }
    if best is None:
        absent = "The harness recorded no pass under each engine's recommended production settings in this run."
        blocks["server-vector-best-config"] = absent
        blocks["server-hybrid-best-config"] = absent
    else:
        blocks["server-vector-best-config"] = _track_block(source, BEST_CONFIG, "vector", _vector_table, comparisons)
        blocks["server-hybrid-best-config"] = _track_block(source, BEST_CONFIG, "hybrid", _quality_table, comparisons)
    return blocks
