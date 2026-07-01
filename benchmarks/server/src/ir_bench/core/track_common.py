from __future__ import annotations

import re

from .types import EngineError


def index_name(dataset_id: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", dataset_id.lower()).strip("_")
    return f"bench_{slug}"


def best_effort(action, label: str):
    try:
        return action()
    except EngineError as error:
        print(f"  warning: {label} unavailable: {error}", flush=True)
        return None


def bulk_load_begin(driver, index: str, spec) -> None:
    """Apply an engine's documented fast-ingest configuration before a large-corpus
    load (for example pausing periodic index refresh). Only large datasets opt in,
    so the small BEIR runs ingest exactly as before, and engines without a hook are
    left untouched."""

    if not getattr(spec, "large", False):
        return
    hook = getattr(driver, "bulk_load_begin", None)
    if hook is not None:
        best_effort(lambda: hook(index), "bulk-load tuning")


def bulk_load_end(driver, index: str, spec) -> None:
    if not getattr(spec, "large", False):
        return
    hook = getattr(driver, "bulk_load_end", None)
    if hook is not None:
        best_effort(lambda: hook(index), "bulk-load restore")


def index_size_bytes(stats: dict | None) -> int | None:
    if not stats:
        return None
    value = stats.get("index_size_bytes")
    return int(value) if isinstance(value, (int, float)) else None


def verify_indexed(driver, index: str, imported, dataset_id: str) -> int:
    if imported.indexed != imported.submitted:
        raise EngineError(
            f"{driver.name} indexed {imported.indexed} of {imported.submitted} submitted "
            f"documents for {dataset_id}"
        )
    server_count = driver.count(index)
    if server_count != imported.indexed:
        raise EngineError(
            f"{driver.name} index reports {server_count} documents, expected {imported.indexed} "
            f"for {dataset_id}"
        )
    return imported.indexed
