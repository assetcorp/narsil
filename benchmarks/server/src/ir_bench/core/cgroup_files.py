from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

ENGINE_STATS_URL_ENV = "BENCH_ENGINE_STATS_URL"
ENGINE_STATS_TIMEOUT_SECONDS = 2.0
ENGINE_MACHINE_PATH = "machine"
ENGINE_STATS_FILES = frozenset(
    {"cpu.stat", "cpuset.cpus.effective", "memory.current", "memory.stat", "memory.peak"}
)


class CgroupFiles(Protocol):
    on_harness_machine: bool

    def read_text(self, name: str) -> str | None: ...

    def machine_cpus(self) -> int | None: ...

    def location(self) -> dict[str, str]: ...


class LocalCgroupFiles:
    on_harness_machine = True

    def __init__(self, cgroup_dir: Path) -> None:
        self.cgroup_dir = Path(cgroup_dir)

    def read_text(self, name: str) -> str | None:
        try:
            return (self.cgroup_dir / name).read_text(encoding="utf-8")
        except OSError:
            return None

    def machine_cpus(self) -> int | None:
        return os.cpu_count()

    def location(self) -> dict[str, str]:
        return {"cgroup_dir": str(self.cgroup_dir)}


class RemoteCgroupFiles:
    on_harness_machine = False

    def __init__(self, base_url: str, timeout_seconds: float = ENGINE_STATS_TIMEOUT_SECONDS) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def _get(self, path: str) -> bytes | None:
        try:
            with urllib.request.urlopen(f"{self.base_url}/{path}", timeout=self.timeout_seconds) as response:
                return response.read()
        except (urllib.error.URLError, OSError, ValueError):
            return None

    def read_text(self, name: str) -> str | None:
        if name not in ENGINE_STATS_FILES:
            return None
        body = self._get(name)
        return None if body is None else body.decode("utf-8", errors="replace")

    def machine(self) -> dict | None:
        body = self._get(ENGINE_MACHINE_PATH)
        if body is None:
            return None
        try:
            loaded = json.loads(body)
        except ValueError:
            return None
        return loaded if isinstance(loaded, dict) else None

    def machine_cpus(self) -> int | None:
        cpus = (self.machine() or {}).get("cpus")
        return cpus if isinstance(cpus, int) and not isinstance(cpus, bool) and cpus > 0 else None

    def host_and_port(self) -> tuple[str, int]:
        parts = urlsplit(self.base_url)
        if parts.hostname is None or parts.port is None:
            raise ValueError(f"{ENGINE_STATS_URL_ENV} must name a host and a port, got {self.base_url!r}")
        return parts.hostname, parts.port

    def location(self) -> dict[str, str]:
        return {"engine_stats_url": self.base_url}


def remote_cgroup_files_from_env(environ) -> RemoteCgroupFiles | None:
    url = (environ.get(ENGINE_STATS_URL_ENV) or "").strip()
    return RemoteCgroupFiles(url) if url else None
