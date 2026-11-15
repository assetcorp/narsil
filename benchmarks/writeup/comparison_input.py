from __future__ import annotations

import copy
import math
import re

_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]*\Z")


def _object(parent: dict, key: str) -> dict:
    value = parent.get(key)
    if value is None:
        parent[key] = {}
    elif not isinstance(value, dict):
        raise SystemExit(f"benchmark writeup: {key} must be an object")
    return parent[key]


def _objects(parent: dict, key: str) -> list[dict]:
    value = parent.get(key)
    if value is None:
        parent[key] = []
    elif not isinstance(value, list) or any(not isinstance(entry, dict) for entry in value):
        raise SystemExit(f"benchmark writeup: {key} must be a list of objects")
    return parent[key]


def _unique(entries: list[dict], key: str) -> None:
    found = set()
    for entry in entries:
        value = entry.get(key)
        if not isinstance(value, str) or not value.strip():
            raise SystemExit(f"benchmark writeup: {key} must be a non-empty string")
        if not _IDENTIFIER.fullmatch(value) or any(part in ("", ".", "..") for part in value.split("/")):
            raise SystemExit(f"benchmark writeup: invalid {key} {value!r}")
        if key in ("engine", "name", "track") and "/" in value:
            raise SystemExit(f"benchmark writeup: invalid {key} {value!r}")
        if "display_name" in entry or "unmeasured" in entry:
            raise SystemExit("benchmark writeup: display_name and unmeasured are reserved for generated rows")
        if value in found:
            raise SystemExit(f"benchmark writeup: duplicate {key} {value!r}")
        found.add(value)


def _numbers(entry: dict, keys) -> None:
    for key in keys:
        value = entry.get(key)
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0
        ):
            raise SystemExit(f"benchmark writeup: {key} must be a finite non-negative number")


def _row(row: dict, target: object) -> None:
    metrics = _object(row, "metrics")
    _numbers(metrics, ("ndcg_cut_10", "recall_100", "map", "recip_rank"))
    _object(row, "operational")
    throughput = _object(row, "throughput")
    for level in _objects(throughput, "levels"):
        _numbers(level, ("concurrency", "qps", "qps_ci_low", "qps_ci_high", "engine_cores_busy"))
        latency = _object(level, "server_latency_ms")
        _numbers(latency, ("p50_ms", "p95_ms", "p99_ms", "p999_ms", "max_ms"))
    point = _object(row, "operating_point")
    _numbers(point, ("target", "achieved_recall"))
    met = point.get("met_target")
    if met is not None and not isinstance(met, bool):
        raise SystemExit("benchmark writeup: met_target must be a boolean")
    recall = point.get("achieved_recall")
    required = point.get("target") if point.get("target") is not None else target
    if recall is not None and required is not None and recall < required:
        point["met_target"] = False
    for sample in _objects(point, "sweep"):
        _numbers(sample, ("recall", "qps"))


def validated_comparison(comparison: dict) -> dict:
    result = copy.deepcopy(comparison)
    config = _object(result, "config")
    _numbers(config, ("recall_target",))
    _object(result, "environment")
    engines = _objects(result, "engines")
    _unique(engines, "name")
    for engine in engines:
        for key in ("build_identity", "environment", "server_setup"):
            _object(engine, key)
    tracks = _objects(result, "tracks")
    _unique(tracks, "track")
    for track in tracks:
        datasets = _objects(track, "datasets")
        _unique(datasets, "dataset_id")
        for dataset in datasets:
            rows = _objects(dataset, "rows")
            _unique(rows, "engine")
            for row in rows:
                _row(row, config.get("recall_target"))
    return result
