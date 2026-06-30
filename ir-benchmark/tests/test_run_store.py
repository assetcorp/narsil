from __future__ import annotations

import json
import re

import pytest

from ir_bench.core.run_store import (
    RUN_ID_ENV,
    latest_run_id,
    mint_run_id,
    resolve_run_id_for_read,
    resolve_run_id_for_write,
    run_directory,
    runs_root,
    validate_engine_name,
    validate_run_id,
    write_run_manifest,
)


def test_mint_run_id_is_utc_timestamp():
    assert re.match(r"^\d{8}T\d{6}Z$", mint_run_id())


@pytest.mark.parametrize("value", ["20260630T160034Z", "narsil", "elastic-search", "engine_1", "a", "A.B_c-1"])
def test_validate_accepts_safe_segments(value):
    assert validate_run_id(value) == value
    assert validate_engine_name(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "",
        ".",
        "..",
        "../escape",
        "a/b",
        "a\\b",
        "/absolute",
        ".hidden",
        "-flag",
        "with space",
        "null\x00byte",
        "x" * 65,
    ],
)
def test_validate_rejects_unsafe_segments(value):
    with pytest.raises(ValueError):
        validate_run_id(value)
    with pytest.raises(ValueError):
        validate_engine_name(value)


def test_run_directory_stays_inside_results(tmp_path):
    directory = run_directory(tmp_path, "20260630T160034Z")
    assert directory == runs_root(tmp_path) / "20260630T160034Z"
    assert directory.resolve().is_relative_to(runs_root(tmp_path).resolve())


def test_run_directory_rejects_traversal(tmp_path):
    with pytest.raises(ValueError):
        run_directory(tmp_path, "../../etc")


def test_latest_run_id_picks_lexical_max(tmp_path):
    root = runs_root(tmp_path)
    for name in ("20260101T000000Z", "20260630T160034Z", "20260315T120000Z"):
        (root / name).mkdir(parents=True)
    assert latest_run_id(tmp_path) == "20260630T160034Z"


def test_latest_run_id_ignores_loose_files_and_bad_names(tmp_path):
    root = runs_root(tmp_path)
    (root / "20260101T000000Z").mkdir(parents=True)
    (root / "comparison-stray.json").write_text("{}", encoding="utf-8")
    (root / "bad name").mkdir()
    assert latest_run_id(tmp_path) == "20260101T000000Z"


def test_latest_run_id_none_when_no_runs(tmp_path):
    assert latest_run_id(tmp_path) is None


def test_resolve_for_write_mints_when_unset(tmp_path, monkeypatch):
    monkeypatch.delenv(RUN_ID_ENV, raising=False)
    assert re.match(r"^\d{8}T\d{6}Z$", resolve_run_id_for_write(None))


def test_resolve_for_write_uses_env(tmp_path, monkeypatch):
    monkeypatch.setenv(RUN_ID_ENV, "20260630T160034Z")
    assert resolve_run_id_for_write(None) == "20260630T160034Z"


def test_resolve_for_write_explicit_overrides_env(monkeypatch):
    monkeypatch.setenv(RUN_ID_ENV, "20260101T000000Z")
    assert resolve_run_id_for_write("20260630T160034Z") == "20260630T160034Z"


def test_resolve_for_write_rejects_unsafe_env(monkeypatch):
    monkeypatch.setenv(RUN_ID_ENV, "../escape")
    with pytest.raises(ValueError):
        resolve_run_id_for_write(None)


def test_resolve_for_read_uses_latest(tmp_path, monkeypatch):
    monkeypatch.delenv(RUN_ID_ENV, raising=False)
    (runs_root(tmp_path) / "20260101T000000Z").mkdir(parents=True)
    (runs_root(tmp_path) / "20260630T160034Z").mkdir(parents=True)
    assert resolve_run_id_for_read(tmp_path, None) == "20260630T160034Z"


def test_resolve_for_read_explicit_wins(tmp_path, monkeypatch):
    monkeypatch.setenv(RUN_ID_ENV, "20260101T000000Z")
    assert resolve_run_id_for_read(tmp_path, "20260630T160034Z") == "20260630T160034Z"


def test_resolve_for_read_errors_when_no_runs(tmp_path, monkeypatch):
    monkeypatch.delenv(RUN_ID_ENV, raising=False)
    with pytest.raises(ValueError):
        resolve_run_id_for_read(tmp_path, None)


def test_write_text_atomic_writes_and_leaves_no_temp(tmp_path):
    from ir_bench.core.reporter import write_text_atomic

    target = tmp_path / "nested" / "out.txt"
    write_text_atomic(target, "payload")
    assert target.read_text(encoding="utf-8") == "payload"
    assert not list((tmp_path / "nested").glob(".*tmp"))


def test_write_text_atomic_overwrites(tmp_path):
    from ir_bench.core.reporter import write_text_atomic

    target = tmp_path / "out.txt"
    write_text_atomic(target, "first")
    write_text_atomic(target, "second")
    assert target.read_text(encoding="utf-8") == "second"


def test_write_text_atomic_preserves_original_on_failure(tmp_path, monkeypatch):
    from ir_bench.core import reporter

    target = tmp_path / "out.txt"
    reporter.write_text_atomic(target, "original")

    def boom(_src, _dst):
        raise OSError("rename failed")

    monkeypatch.setattr(reporter.os, "replace", boom)
    with pytest.raises(OSError):
        reporter.write_text_atomic(target, "replacement")

    assert target.read_text(encoding="utf-8") == "original"
    assert not list(tmp_path.glob(".*tmp"))


def test_write_run_manifest_records_identity_and_preserves_created_at(tmp_path):
    environment = {"captured_at": "2026-06-30T16:00:00+00:00", "harness_version": "0.3.0", "os": "Linux 6"}
    path = write_run_manifest(tmp_path, "20260630T160034Z", environment)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    assert manifest["run_id"] == "20260630T160034Z"
    assert manifest["created_at"] == "2026-06-30T16:00:00+00:00"
    assert manifest["environment"] == environment

    later = {"captured_at": "2026-06-30T16:05:00+00:00", "harness_version": "0.3.0", "os": "Linux 6"}
    write_run_manifest(tmp_path, "20260630T160034Z", later)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    assert manifest["created_at"] == "2026-06-30T16:00:00+00:00"
    assert manifest["environment"] == later
