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
