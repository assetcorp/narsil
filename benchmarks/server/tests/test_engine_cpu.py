from __future__ import annotations

from pathlib import Path

import pytest

from ir_bench.core.engine_cpu import CgroupCpuCounter, cores_busy, engine_cpu_counter_from_env, locate_engine_cgroup

CONTAINER_ID = "02ee9fa0024282486b14b90ac21b27456bc665a7391d8d857211f0cc3144fec8"


def _write_cpu_stat(directory: Path, usage_usec: int) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "cpu.stat").write_text(
        f"usage_usec {usage_usec}\nuser_usec {usage_usec // 2}\nsystem_usec {usage_usec // 2}\n", encoding="utf-8"
    )


def test_counter_reads_usage_from_the_cgroup_cpu_stat(tmp_path):
    _write_cpu_stat(tmp_path, 2_061_000)
    assert CgroupCpuCounter(tmp_path).usage_usec() == 2_061_000


def test_counter_reads_none_when_the_file_is_missing_or_malformed(tmp_path):
    assert CgroupCpuCounter(tmp_path).usage_usec() is None
    (tmp_path / "cpu.stat").write_text("nr_periods 0\n", encoding="utf-8")
    assert CgroupCpuCounter(tmp_path).usage_usec() is None


def test_cores_busy_is_cpu_time_over_wall_time():
    assert cores_busy(1_000_000, 4_000_000, 1.5) == pytest.approx(2.0)


@pytest.mark.parametrize(("before", "after", "elapsed"), [(None, 5, 1.0), (5, None, 1.0), (5, 9, 0.0), (9, 5, 1.0)])
def test_cores_busy_is_absent_without_two_readings_and_a_window(before, after, elapsed):
    assert cores_busy(before, after, elapsed) is None


def test_locates_the_container_cgroup_under_a_cgroupfs_driver(tmp_path):
    _write_cpu_stat(tmp_path / "docker" / CONTAINER_ID, 1)
    _write_cpu_stat(tmp_path / "docker" / "buildx", 1)
    assert locate_engine_cgroup(tmp_path, CONTAINER_ID) == tmp_path / "docker" / CONTAINER_ID


def test_locates_the_container_cgroup_under_a_systemd_driver(tmp_path):
    scope = tmp_path / "system.slice" / f"docker-{CONTAINER_ID}.scope"
    _write_cpu_stat(scope, 1)
    assert locate_engine_cgroup(tmp_path, CONTAINER_ID) == scope


def test_locate_returns_none_for_an_unknown_container_or_a_blank_id(tmp_path):
    _write_cpu_stat(tmp_path / "docker" / CONTAINER_ID, 1)
    assert locate_engine_cgroup(tmp_path, "deadbeef") is None
    assert locate_engine_cgroup(tmp_path, "") is None


def test_counter_from_env_resolves_the_root_and_container(tmp_path):
    _write_cpu_stat(tmp_path / "docker" / CONTAINER_ID, 7)
    counter = engine_cpu_counter_from_env({"BENCH_CGROUP_ROOT": str(tmp_path), "BENCH_ENGINE_CONTAINER_ID": CONTAINER_ID})
    assert counter is not None
    assert counter.usage_usec() == 7
    assert engine_cpu_counter_from_env({"BENCH_CGROUP_ROOT": str(tmp_path)}) is None
    assert engine_cpu_counter_from_env({"BENCH_ENGINE_CONTAINER_ID": CONTAINER_ID}) is None
