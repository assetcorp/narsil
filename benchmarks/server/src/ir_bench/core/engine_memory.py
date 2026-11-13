from __future__ import annotations

import re
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Callable, TypeVar

from .engine_cpu import CGROUP_ROOT_ENV, ENGINE_CONTAINER_ID_ENV, locate_engine_cgroup

T = TypeVar("T")

MEMORY_CURRENT_FILENAME = "memory.current"
MEMORY_STAT_FILENAME = "memory.stat"
MEMORY_PEAK_FILENAME = "memory.peak"
MEMORY_SAMPLE_INTERVAL_SECONDS = 0.25
MEMORY_COUNTER_SOURCE = (
    "engine container cgroup memory.current and memory.stat anon, sampled every "
    f"{MEMORY_SAMPLE_INTERVAL_SECONDS:g} s through each track"
)

_ANON_LINE = re.compile(r"^anon (\d+)$", re.MULTILINE)


def _read_integer(path: Path) -> int | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return int(text) if text.isdigit() else None


class CgroupMemoryCounter:
    def __init__(self, cgroup_dir: Path, interval_seconds: float = MEMORY_SAMPLE_INTERVAL_SECONDS) -> None:
        self.cgroup_dir = Path(cgroup_dir)
        self.interval_seconds = interval_seconds

    def current_bytes(self) -> int | None:
        return _read_integer(self.cgroup_dir / MEMORY_CURRENT_FILENAME)

    def anon_bytes(self) -> int | None:
        try:
            text = (self.cgroup_dir / MEMORY_STAT_FILENAME).read_text(encoding="utf-8")
        except OSError:
            return None
        match = _ANON_LINE.search(text)
        return int(match.group(1)) if match else None

    def container_peak_bytes(self) -> int | None:
        return _read_integer(self.cgroup_dir / MEMORY_PEAK_FILENAME)

    def describe(self) -> dict[str, str]:
        return {"source": MEMORY_COUNTER_SOURCE, "cgroup_dir": str(self.cgroup_dir)}

    def measure(self, run: Callable[[], T]) -> tuple[T, dict]:
        peaks = {"current": None, "anon": None, "samples": 0}
        stop = threading.Event()

        def sample() -> None:
            current = self.current_bytes()
            anon = self.anon_bytes()
            if current is not None and (peaks["current"] is None or current > peaks["current"]):
                peaks["current"] = current
            if anon is not None and (peaks["anon"] is None or anon > peaks["anon"]):
                peaks["anon"] = anon
            peaks["samples"] += 1

        def loop() -> None:
            while not stop.is_set():
                sample()
                stop.wait(self.interval_seconds)

        sampler = threading.Thread(target=loop, name="engine-memory-sampler", daemon=True)
        sampler.start()
        try:
            result = run()
        finally:
            stop.set()
            sampler.join()
        sample()
        return result, {
            "peak_charged_bytes": peaks["current"],
            "peak_anon_bytes": peaks["anon"],
            "container_lifetime_peak_bytes": self.container_peak_bytes(),
            "samples": peaks["samples"],
            "interval_seconds": self.interval_seconds,
            "source": MEMORY_COUNTER_SOURCE,
        }


def engine_memory_counter_from_env(environ: Mapping[str, str]) -> CgroupMemoryCounter | None:
    root = (environ.get(CGROUP_ROOT_ENV) or "").strip()
    container_id = (environ.get(ENGINE_CONTAINER_ID_ENV) or "").strip()
    if not root or not container_id:
        return None
    cgroup_dir = locate_engine_cgroup(Path(root), container_id)
    if cgroup_dir is None or not (cgroup_dir / MEMORY_CURRENT_FILENAME).is_file():
        return None
    return CgroupMemoryCounter(cgroup_dir)
