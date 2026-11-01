from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from .engine_cpu import CGROUP_ROOT_ENV, ENGINE_CONTAINER_ID_ENV, locate_engine_cgroup

MEMORY_STAT_FILENAME = "memory.stat"
MEMORY_CURRENT_FILENAME = "memory.current"
_REPORTED_STATS = {"anon": "anonymous_bytes", "file": "page_cache_bytes"}


def read_engine_memory(environ: Mapping[str, str]) -> dict[str, int] | None:
    root = (environ.get(CGROUP_ROOT_ENV) or "").strip()
    container_id = (environ.get(ENGINE_CONTAINER_ID_ENV) or "").strip()
    if not root or not container_id:
        return None
    directory = locate_engine_cgroup(Path(root), container_id)
    if directory is None:
        return None
    try:
        report = {"total_bytes": int((directory / MEMORY_CURRENT_FILENAME).read_text(encoding="utf-8").strip())}
        for line in (directory / MEMORY_STAT_FILENAME).read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition(" ")
            if name in _REPORTED_STATS:
                report[_REPORTED_STATS[name]] = int(value)
    except (OSError, ValueError):
        return None
    return report
