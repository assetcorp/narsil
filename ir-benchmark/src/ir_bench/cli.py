from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .core.config import load_config, select_datasets, select_engine
from .core.embeddings import EmbeddingStore
from .core.environment import capture_environment
from .core.harness import run_engine
from .core.registry import build_driver
from .core.reporter import build_engine_report, render_engine_markdown, write_json, write_text_atomic
from .core.run_store import resolve_run_id_for_write, run_directory, validate_engine_name, write_run_manifest
from .core.types import BEST_CONFIG, EQUAL_PRECISION, HYBRID, VECTOR, VECTOR_PROFILES


def _embeddings_dir() -> Path:
    return Path(os.environ.get("BENCH_EMBEDDINGS_DIR", "/data/embeddings"))


def _safe_build_identity(driver) -> dict | None:
    fetch = getattr(driver, "build_identity", None)
    if fetch is None:
        return None
    try:
        return fetch()
    except Exception:
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Benchmark one search engine over HTTP and score keyword retrieval.")
    parser.add_argument("--config", type=Path, default=Path("config/benchmark.toml"))
    parser.add_argument("--engine", default=None, help="engine name from the config (default: $ENGINE or narsil)")
    parser.add_argument("--results-dir", type=Path, default=Path("results"))
    parser.add_argument(
        "--run-id",
        default=None,
        help="group this engine's result under a run id (or $BENCH_RUN_ID); "
        "defaults to a new UTC timestamp so a standalone run still gets its own directory",
    )
    parser.add_argument(
        "--datasets",
        default=None,
        help="comma-separated subset of configured dataset ids (or $BENCH_DATASETS); "
        "the default runs every dataset not flagged large",
    )
    parser.add_argument(
        "--vector-profile",
        default=None,
        choices=VECTOR_PROFILES,
        help="vector/hybrid precision profile (or $BENCH_VECTOR_PROFILE); "
        f"'{EQUAL_PRECISION}' (default) holds every engine at full float, "
        f"'{BEST_CONFIG}' lets each engine use its recommended production quantization",
    )
    args = parser.parse_args(argv)

    config = load_config(args.config)
    engine_cfg = select_engine(config, args.engine)
    specs = select_datasets(config, args.datasets or os.environ.get("BENCH_DATASETS"))
    vector_profile = args.vector_profile or os.environ.get("BENCH_VECTOR_PROFILE") or EQUAL_PRECISION
    if vector_profile not in VECTOR_PROFILES:
        raise SystemExit(f"unknown vector profile '{vector_profile}'; allowed: {', '.join(VECTOR_PROFILES)}")

    driver = build_driver(engine_cfg, config.bm25)
    environment = capture_environment()
    engine_info = {
        "name": engine_cfg.name,
        "run_tag": engine_cfg.run_tag,
        "ranking": engine_cfg.ranking,
        "url": engine_cfg.url,
        "version": os.environ.get("ENGINE_VERSION"),
        "image_digest": os.environ.get("ENGINE_IMAGE_DIGEST") or None,
        "build_identity": None,
        "tracks": list(engine_cfg.tracks),
        "keyword_setup": getattr(driver, "keyword_setup", None),
        "vector_profile": vector_profile,
    }
    config_summary = {
        "k1": config.bm25.k1,
        "b": config.bm25.b,
        "run_depth": config.run_depth,
        "memory_cap_bytes": config.memory_cap_bytes,
        "throughput": {
            "enabled": config.throughput.enabled,
            "concurrency": list(config.throughput.concurrency),
            "duration_seconds": config.throughput.duration_seconds,
            "warmup_seconds": config.throughput.warmup_seconds,
        },
    }
    if config.vector is not None:
        config_summary.update(
            {
                "vector_model": config.vector.model,
                "vector_dims": config.vector.dims,
                "vector_metric": config.vector.metric,
                "recall_target": config.vector.recall_target,
                "recall_k": config.vector.recall_k,
            }
        )

    needs_vectors = any(track in (VECTOR, HYBRID) for track in engine_cfg.tracks)
    store = EmbeddingStore(config.vector, _embeddings_dir()) if (needs_vectors and config.vector) else None

    try:
        run_id = resolve_run_id_for_write(args.run_id)
        engine_name = validate_engine_name(engine_cfg.name)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    directory = run_directory(args.results_dir, run_id)
    runfiles_dir = directory / "runfiles"
    runfiles_dir.mkdir(parents=True, exist_ok=True)

    try:
        print(f"waiting for {engine_cfg.name} at {engine_cfg.url} (vector profile: {vector_profile})", flush=True)
        results = run_engine(driver, engine_cfg, config, specs, runfiles_dir, store, vector_profile)
        engine_info["build_identity"] = _safe_build_identity(driver)
    finally:
        driver.close()

    if not results:
        print(f"no tracks ran for {engine_cfg.name} under the {vector_profile} profile; nothing to write", flush=True)
        return 0

    config_summary["vector_profile"] = vector_profile
    report = build_engine_report(environment, engine_info, config_summary, results)
    suffix = "-bestconfig" if vector_profile == BEST_CONFIG else ""
    write_json(directory / f"engine-{engine_name}{suffix}.json", report)
    markdown = render_engine_markdown(report)
    write_text_atomic(directory / f"engine-{engine_name}{suffix}.md", markdown)
    write_run_manifest(args.results_dir, run_id, environment)
    print("\n" + markdown, flush=True)

    outside = [
        r["dataset_id"]
        for r in results
        if r.get("calibration") and not r["calibration"]["within_margin"]
    ]
    if outside:
        print(f"\nReference check: {len(outside)} dataset(s) outside margin: {', '.join(outside)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
