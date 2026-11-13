from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

import ir_bench
from ir_bench.core.engine_cpu import engine_cpu_counter_from_env
from ir_bench.core.engine_host import remote_engine_environment
from ir_bench.core.engine_memory import engine_memory_counter_from_env

CONTAINER_ID = "9c1f4be3a8d2470e8a51f3c6d0b7e2a49c1f4be3a8d2470e8a51f3c6d0b7e2a4"
SOURCE_DIR = Path(ir_bench.__file__).resolve().parents[1]
STARTUP_DEADLINE_SECONDS = 10.0


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _write_engine_cgroup(root: Path) -> Path:
    scope = root / "system.slice" / f"docker-{CONTAINER_ID}.scope"
    scope.mkdir(parents=True)
    (scope / "cpu.stat").write_text("usage_usec 7340032\nuser_usec 5000000\nsystem_usec 2340032\n", encoding="utf-8")
    (scope / "cpuset.cpus.effective").write_text("0-3,8-11\n", encoding="utf-8")
    (scope / "memory.current").write_text("524288000\n", encoding="utf-8")
    (scope / "memory.stat").write_text("anon 419430400\nfile 104857600\n", encoding="utf-8")
    (scope / "memory.peak").write_text("629145600\n", encoding="utf-8")
    (scope / "cgroup.procs").write_text("4242\n", encoding="utf-8")
    return scope


def _start_stats_server(root: Path, port: int, container_id: str = CONTAINER_ID) -> subprocess.Popen:
    env = {**os.environ, "PYTHONPATH": str(SOURCE_DIR)}
    return subprocess.Popen(
        [sys.executable, "-m", "ir_bench.engine_stats", "--host", "127.0.0.1", "--port", str(port),
         "--container-id", container_id, "--cgroup-root", str(root)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


@pytest.fixture
def stats_url(tmp_path):
    _write_engine_cgroup(tmp_path)
    port = _free_port()
    server = _start_stats_server(tmp_path, port)
    deadline = time.monotonic() + STARTUP_DEADLINE_SECONDS
    while True:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            break
        except OSError:
            if server.poll() is not None or time.monotonic() > deadline:
                server.kill()
                raise RuntimeError(f"stats server never listened: {server.communicate()[1]!r}")
            time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.terminate()
    server.wait(timeout=5)


def _status_of(url: str) -> int:
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def test_a_harness_on_another_machine_reads_the_engine_cgroup_figures_written_on_the_engine_machine(stats_url):
    environ = {"BENCH_ENGINE_STATS_URL": stats_url}
    cpu = engine_cpu_counter_from_env(environ)
    memory = engine_memory_counter_from_env(environ)
    assert cpu is not None and memory is not None
    assert cpu.usage_usec() == 7_340_032
    assert cpu.cores_allowed() == 8
    assert cpu.on_harness_machine() is False
    assert cpu.machine_cpus() == os.cpu_count()
    result, peaks = memory.measure(lambda: "measured")
    assert result == "measured"
    assert peaks["peak_charged_bytes"] == 524_288_000
    assert peaks["peak_anon_bytes"] == 419_430_400
    assert peaks["container_lifetime_peak_bytes"] == 629_145_600


@pytest.mark.parametrize(
    "path",
    ["cgroup.procs", "../cpu.stat", "system.slice/cpu.stat", "%2e%2e/%2e%2e/etc/passwd", "../../../../etc/passwd", ""],
)
def test_the_stats_service_refuses_every_path_outside_its_allowlist(stats_url, path):
    assert _status_of(f"{stats_url}/{path}") == 404


def test_each_result_records_the_engine_machine_and_two_hundred_round_trips(stats_url):
    recorded = remote_engine_environment({"BENCH_ENGINE_STATS_URL": stats_url})
    assert recorded is not None
    assert recorded["engine_machine"]["cpus"] == os.cpu_count()
    network = recorded["network"]
    assert network["samples"] == 200
    assert network["method"] == "tcp_connect"
    round_trip = network["round_trip_ms"]
    assert 0 < round_trip["min"] <= round_trip["p50"] <= round_trip["p99"] <= round_trip["max"]


def test_the_stats_service_exits_when_no_cgroup_holds_the_container(tmp_path):
    _write_engine_cgroup(tmp_path)
    server = _start_stats_server(tmp_path, _free_port(), container_id="deadbeef")
    _, stderr = server.communicate(timeout=10)
    assert server.returncode == 1
    assert b"deadbeef" in stderr


def test_an_unreachable_stats_service_leaves_the_engine_figures_unrecorded():
    environ = {"BENCH_ENGINE_STATS_URL": f"http://127.0.0.1:{_free_port()}"}
    assert engine_memory_counter_from_env(environ) is None
    cpu = engine_cpu_counter_from_env(environ)
    assert cpu is not None
    assert cpu.usage_usec() is None
