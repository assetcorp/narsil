from __future__ import annotations

from typing import Any


def levels(obj: Any) -> list[dict]:
    """The per-concurrency records, accepting either a per-dataset result (which
    holds the throughput block under `throughput`) or the throughput block itself
    (which holds the records under `levels`), so the per-engine and cross-engine
    reporters can both read them."""

    if not isinstance(obj, dict):
        return []
    block = obj.get("throughput") if "throughput" in obj else obj
    if not isinstance(block, dict):
        return []
    items = block.get("levels")
    return [level for level in items if isinstance(level, dict)] if isinstance(items, list) else []


def peak_level(obj: Any) -> dict | None:
    """The highest-QPS level an engine reached. Peak is taken by measured rate, not
    by the largest concurrency, so a level where the harness throttled the rate
    cannot masquerade as the engine's capacity."""

    found = levels(obj)
    if not found:
        return None
    return max(found, key=lambda level: level.get("qps") or 0.0)


def _num(value: Any, places: int) -> str:
    return f"{value:.{places}f}" if isinstance(value, (int, float)) and not isinstance(value, bool) else "n/a"


def _errors(level: dict) -> str:
    errors = level.get("errors") or 0
    if not errors:
        return "0"
    rate = level.get("error_rate") or 0.0
    return f"{errors} ({rate * 100:.1f}%)"


def per_engine_lines(result: dict) -> list[str]:
    found = levels(result)
    if not found:
        return []
    lines = [
        "Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). "
        "Per-request latency here is measured under that load, separate from the serial latency above. "
        "Client-limited marks a level where the harness, not the engine, capped the rate:",
        "",
        "| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for level in found:
        client = level.get("client_latency_ms", {})
        lines.append(
            "| {c} | {passes} | {qps} | {ci} | {err} | {p95} | {p999} | {cores} | {ach} | {bound} |".format(
                c=level.get("concurrency", "n/a"),
                passes=level.get("pass_count", 1),
                qps=_num(level.get("qps"), 0),
                ci=_interval(level),
                err=_errors(level),
                p95=_num(client.get("p95_ms"), 2),
                p999=_num(client.get("p999_ms"), 2),
                cores=_num(level.get("engine_cores_busy"), 2),
                ach=_num(level.get("achieved_concurrency"), 1),
                bound="yes" if level.get("client_bound") else "no",
            )
        )
    return lines


def _interval(level: dict) -> str:
    low = level.get("qps_ci_low")
    high = level.get("qps_ci_high")
    if not isinstance(low, (int, float)) or not isinstance(high, (int, float)) or low == high:
        return "n/a"
    return f"{low:.0f} to {high:.0f}"


def comparison_lines(rows: list[dict]) -> list[str]:
    """One peak-throughput row per engine for a dataset, the capacity headline that
    stays meaningful where single-query latency floors out on small corpora."""

    peaks = [(row["engine"], peak_level(row.get("throughput"))) for row in rows]
    measured = [peak.get("qps") for _, peak in peaks if peak and isinstance(peak.get("qps"), (int, float))]
    if not measured:
        return []
    best_qps = max(measured)
    has_distinct_best = len(set(measured)) > 1
    lines = [
        "Throughput under concurrent load (higher is better). Peak QPS is the highest sustained rate across the "
        "tested concurrency levels, and 'client-limited' flags an engine whose peak the harness capped, not the "
        "engine itself. A star marks the best:",
        "",
        "| Engine | Peak QPS | 95% CI | At concurrency | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Client-limited |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for engine, peak in peaks:
        if not peak:
            lines.append(f"| {engine} | n/a | n/a | n/a | n/a | n/a | n/a | n/a |")
            continue
        qps = peak.get("qps")
        marker = "\\*" if has_distinct_best and isinstance(qps, (int, float)) and abs(qps - best_qps) < 1e-9 else ""
        client = peak.get("client_latency_ms", {})
        lines.append(
            "| {engine} | {qps}{marker} | {ci} | {c} | {p95} | {p999} | {cores} | {bound} |".format(
                engine=engine,
                qps=_num(qps, 0),
                marker=marker,
                ci=_interval(peak),
                c=peak.get("concurrency", "n/a"),
                p95=_num(client.get("p95_ms"), 2),
                p999=_num(client.get("p999_ms"), 2),
                cores=_num(peak.get("engine_cores_busy"), 2),
                bound="yes" if peak.get("client_bound") else "no",
            )
        )
    return lines
