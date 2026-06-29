from __future__ import annotations

import os
import platform
from datetime import datetime, timezone
from pathlib import Path

from . import __version__
from .datasets import dataset_version
from .scoring import pytrec_eval_version


def _cpu_model() -> str | None:
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        for line in cpuinfo.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
    return platform.processor() or None


def _total_memory_bytes() -> int | None:
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        for line in meminfo.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) * 1024
    return None


def capture_environment() -> dict:
    return {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "harness_version": __version__,
        "containerized": Path("/.dockerenv").exists(),
        "machine_label": os.environ.get("BENCH_MACHINE_LABEL"),
        "os": f"{platform.system()} {platform.release()}",
        "arch": platform.machine(),
        "cpu_model": _cpu_model(),
        "logical_cpus": os.cpu_count(),
        "total_memory_bytes": _total_memory_bytes(),
        "python_version": platform.python_version(),
        "ir_datasets_version": dataset_version(),
        "pytrec_eval_version": pytrec_eval_version(),
    }
