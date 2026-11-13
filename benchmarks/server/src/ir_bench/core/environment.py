from __future__ import annotations

import os
import platform
from datetime import datetime, timezone
from pathlib import Path

from .. import __version__
from .cpu_sets import usable_cpus
from .datasets import dataset_version
from .host_info import cpu_model, total_memory_bytes
from .scoring import pytrec_eval_version


def capture_environment() -> dict:
    return {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "harness_version": __version__,
        "containerized": Path("/.dockerenv").exists(),
        "machine_label": os.environ.get("BENCH_MACHINE_LABEL"),
        "engine_machine_label": os.environ.get("BENCH_ENGINE_MACHINE_LABEL") or None,
        "os": f"{platform.system()} {platform.release()}",
        "arch": platform.machine(),
        "cpu_model": cpu_model(),
        "logical_cpus": os.cpu_count(),
        "harness_cpus": usable_cpus(),
        "total_memory_bytes": total_memory_bytes(),
        "python_version": platform.python_version(),
        "ir_datasets_version": dataset_version(),
        "pytrec_eval_version": pytrec_eval_version(),
    }
