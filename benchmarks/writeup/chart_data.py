from __future__ import annotations

from render import engine_name, is_number

TRACK_TITLES = {"keyword": "Keyword", "vector": "Vector", "hybrid": "Hybrid"}
PROFILE_TITLES = {"equal-precision": "equal precision", "best-config": "recommended production settings"}
EQUAL_PRECISION = "equal-precision"
BEST_CONFIG = "best-config"
PERCENTILE_FIELDS = ("p50_ms", "p95_ms", "p99_ms", "p999_ms", "max_ms")
PERCENTILE_LABELS = ("p50", "p95", "p99", "p99.9", "max")


def number(value: object) -> float | None:
    return float(value) if is_number(value) else None


def levels(row: dict) -> list[dict]:
    block = row.get("throughput") or {}
    items = block.get("levels") or []
    return [level for level in items if isinstance(level, dict)]


def peak_level(row: dict) -> dict | None:
    found = levels(row)
    if not found:
        return None
    return max(found, key=lambda level: level.get("qps") or 0.0)


def peak_qps(row: dict) -> float | None:
    peak = peak_level(row)
    return None if peak is None else number(peak.get("qps"))


def peak_interval(row: dict) -> tuple[float, float] | None:
    peak = peak_level(row)
    if peak is None:
        return None
    low = number(peak.get("qps_ci_low"))
    high = number(peak.get("qps_ci_high"))
    return None if low is None or high is None else (low, high)


def cores_allowed(rows: list[dict]) -> float | None:
    for row in rows:
        value = number((row.get("throughput") or {}).get("engine_cores_allowed"))
        if value:
            return value
    return None


def has_cores(rows: list[dict]) -> bool:
    return any(number(level.get("engine_cores_busy")) is not None for row in rows for level in levels(row))


def concurrencies(rows: list[dict]) -> list[float]:
    found = {number(level.get("concurrency")) for row in rows for level in levels(row)}
    return sorted(value for value in found if value is not None)


def tail_profile(row: dict) -> list[tuple[int, float]]:
    peak = peak_level(row)
    if peak is None:
        return []
    latency = peak.get("server_latency_ms") or {}
    points = []
    for position, field in enumerate(PERCENTILE_FIELDS):
        value = number(latency.get(field))
        if value is not None and value > 0:
            points.append((position, value))
    return points


def recall_curve(row: dict) -> list[tuple[float, float]]:
    sweep = (row.get("operating_point") or {}).get("sweep") or []
    points = []
    for entry in sweep:
        recall = number(entry.get("recall"))
        qps = number(entry.get("qps"))
        if recall is not None and qps is not None:
            points.append((recall, qps))
    return sorted(points)


def track(comparison: dict | None, name: str) -> dict | None:
    return next((entry for entry in (comparison or {}).get("tracks", []) if entry.get("track") == name), None)


def tracks(comparison: dict) -> list[dict]:
    return [entry for entry in comparison.get("tracks", []) if entry.get("datasets")]


def dataset_rows(comparison: dict | None, name: str, dataset_id: str) -> list[dict]:
    entry = track(comparison, name)
    if entry is None:
        return []
    for dataset in entry["datasets"]:
        if dataset["dataset_id"] == dataset_id:
            return dataset["rows"]
    return []


def has_bars(rows: list[dict]) -> bool:
    return any(number((row.get("metrics") or {}).get("ndcg_cut_10")) is not None or peak_qps(row) is not None for row in rows)


def has_sweep(rows: list[dict]) -> bool:
    return len(concurrencies(rows)) > 1


def row_label(row: dict, profile: str) -> str:
    name = engine_name(row["engine"])
    quantization = row.get("quantization")
    if profile == BEST_CONFIG and isinstance(quantization, str) and quantization:
        return f"{name} ({quantization})"
    return name


def has_tail(datasets: list[dict]) -> bool:
    return any(tail_profile(row) for dataset in datasets for row in dataset["rows"])


def has_recall_curve(comparisons: dict[str, dict | None], dataset_id: str) -> bool:
    return any(recall_curve(row) for comparison in comparisons.values() for row in dataset_rows(comparison, "vector", dataset_id))


def track_title(name: str) -> str:
    return TRACK_TITLES.get(name, name[:1].upper() + name[1:])


def profile_title(profile: str) -> str:
    return PROFILE_TITLES.get(profile, profile)
