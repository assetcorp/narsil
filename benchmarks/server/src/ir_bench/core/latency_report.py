from __future__ import annotations

from typing import Any

from .types import INTEGER_MS, NOT_AVAILABLE

_PERCENTILE_KEYS = ("samples", "top_k", "mean_ms", "p50_ms", "p90_ms", "p95_ms", "p99_ms", "max_ms")

_RESOLUTION_NOTES = {
    INTEGER_MS: "integer-millisecond resolution; sub-millisecond searches floor to 0-1 ms",
    NOT_AVAILABLE: "no server-side query time exposed",
}


def client_summary(latency: dict[str, Any]) -> dict[str, Any]:
    """The client round-trip percentile set. Falls back to the top-level keys, which
    carry the client set for backward compatibility with earlier result files."""

    nested = latency.get("client")
    if isinstance(nested, dict):
        return nested
    return {key: latency.get(key) for key in _PERCENTILE_KEYS}


def server_summary(latency: dict[str, Any]) -> dict[str, Any] | None:
    """The engine-reported (headline) percentile set, or None when the engine
    exposes no server-side query time. None is distinct from a real 0 ms set."""

    nested = latency.get("server")
    return nested if isinstance(nested, dict) else None


def has_server_time(latency: dict[str, Any]) -> bool:
    return server_summary(latency) is not None


def disclosure(latency: dict[str, Any]) -> str:
    """A one-line, per-engine statement of where the headline server time comes from
    and at what resolution, so an integer-ms-floored number cannot be mistaken for a
    precise one."""

    source = latency.get("server_time_source") or "client round-trip only"
    resolution = latency.get("server_time_resolution") or NOT_AVAILABLE
    note = _RESOLUTION_NOTES.get(resolution)
    if note:
        return f"{source} ({note})"
    return f"{source} ({resolution} resolution)"
