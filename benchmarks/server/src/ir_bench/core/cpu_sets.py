from __future__ import annotations

import os

CPUSET_EFFECTIVE_FILENAME = "cpuset.cpus.effective"


def usable_cpus() -> int:
    affinity = getattr(os, "sched_getaffinity", None)
    if affinity is not None:
        try:
            allowed = len(affinity(0))
        except OSError:
            allowed = 0
        if allowed > 0:
            return allowed
    return os.cpu_count() or 1


def count_cpu_list(text: str) -> int | None:
    total = 0
    for part in text.strip().split(","):
        part = part.strip()
        if not part:
            continue
        first, _, last = part.partition("-")
        try:
            low = int(first)
            high = int(last) if last else low
        except ValueError:
            return None
        if low < 0 or high < low:
            return None
        total += high - low + 1
    return total or None
