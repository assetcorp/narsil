from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path

from .cgroup_files import CgroupFiles, LocalCgroupFiles, remote_cgroup_files_from_env
from .cpu_sets import CPUSET_EFFECTIVE_FILENAME, count_cpu_list

CPU_STAT_FILENAME = "cpu.stat"
CGROUP_ROOT_ENV = "BENCH_CGROUP_ROOT"
ENGINE_CONTAINER_ID_ENV = "BENCH_ENGINE_CONTAINER_ID"
CGROUP_SEARCH_DEPTH = 3
COUNTER_SOURCE = "engine container cgroup cpu.stat usage_usec"

_USAGE_LINE = re.compile(r"^usage_usec (\d+)$", re.MULTILINE)


class CgroupCpuCounter:
    def __init__(self, files: CgroupFiles | Path) -> None:
        self.files: CgroupFiles = LocalCgroupFiles(files) if isinstance(files, Path) else files

    def usage_usec(self) -> int | None:
        text = self.files.read_text(CPU_STAT_FILENAME)
        match = _USAGE_LINE.search(text) if text is not None else None
        return int(match.group(1)) if match else None

    def cores_allowed(self) -> int | None:
        text = self.files.read_text(CPUSET_EFFECTIVE_FILENAME)
        return count_cpu_list(text) if text is not None else None

    def on_harness_machine(self) -> bool:
        return self.files.on_harness_machine

    def machine_cpus(self) -> int | None:
        return self.files.machine_cpus()

    def describe(self) -> dict[str, str]:
        return {"source": COUNTER_SOURCE, **self.files.location()}


def cores_busy(before_usec: int | None, after_usec: int | None, elapsed_seconds: float) -> float | None:
    if before_usec is None or after_usec is None or elapsed_seconds <= 0 or after_usec < before_usec:
        return None
    return (after_usec - before_usec) / (elapsed_seconds * 1_000_000)


def locate_engine_cgroup(root: Path, container_id: str, max_depth: int = CGROUP_SEARCH_DEPTH) -> Path | None:
    root = Path(root)
    if not container_id or not root.is_dir():
        return None
    frontier = [(root, 0)]
    while frontier:
        directory, depth = frontier.pop(0)
        try:
            children = sorted(child for child in directory.iterdir() if child.is_dir())
        except OSError:
            continue
        for child in children:
            if container_id in child.name and (child / CPU_STAT_FILENAME).is_file():
                return child
            if depth + 1 < max_depth:
                frontier.append((child, depth + 1))
    return None


def engine_cpu_counter_from_env(environ: Mapping[str, str]) -> CgroupCpuCounter | None:
    remote = remote_cgroup_files_from_env(environ)
    if remote is not None:
        return CgroupCpuCounter(remote)
    root = (environ.get(CGROUP_ROOT_ENV) or "").strip()
    container_id = (environ.get(ENGINE_CONTAINER_ID_ENV) or "").strip()
    if not root or not container_id:
        return None
    cgroup_dir = locate_engine_cgroup(Path(root), container_id)
    return CgroupCpuCounter(cgroup_dir) if cgroup_dir is not None else None
