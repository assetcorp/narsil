from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .core.config import BenchmarkConfig, DatasetSpec, load_config, select_engine
from .core.environment import capture_environment
from .core.harness import run_engine
from .core.registry import build_driver
from .core.reporter import build_engine_report, render_engine_markdown, write_json


def _select(config: BenchmarkConfig, only: str | None) -> tuple[DatasetSpec, ...]:
    if not only:
        return config.datasets
    wanted = {name.strip() for name in only.split(",") if name.strip()}
    selected = tuple(spec for spec in config.datasets if spec.dataset_id in wanted)
    if not selected:
        raise SystemExit(f"no configured datasets matched: {sorted(wanted)}")
    return selected


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Benchmark one search engine over HTTP and score keyword retrieval.")
    parser.add_argument("--config", type=Path, default=Path("config/benchmark.toml"))
    parser.add_argument("--engine", default=None, help="engine name from the config (default: $ENGINE or narsil)")
    parser.add_argument("--results-dir", type=Path, default=Path("results"))
    parser.add_argument("--runs-dir", type=Path, default=Path("runs"))
    parser.add_argument("--datasets", default=None, help="comma-separated subset of configured dataset ids")
    args = parser.parse_args(argv)

    config = load_config(args.config)
    engine_cfg = select_engine(config, args.engine)
    specs = _select(config, args.datasets)

    driver = build_driver(engine_cfg, config.bm25)
    environment = capture_environment()
    engine_info = {
        "name": engine_cfg.name,
        "run_tag": engine_cfg.run_tag,
        "ranking": engine_cfg.ranking,
        "url": engine_cfg.url,
        "version": os.environ.get("ENGINE_VERSION"),
        "keyword_setup": driver.keyword_setup,
    }
    config_summary = {
        "k1": config.bm25.k1,
        "b": config.bm25.b,
        "run_depth": config.run_depth,
        "memory_cap_bytes": config.memory_cap_bytes,
    }

    try:
        print(f"waiting for {engine_cfg.name} at {engine_cfg.url}", flush=True)
        results = run_engine(driver, config, specs, args.runs_dir)
    finally:
        driver.close()

    report = build_engine_report(environment, engine_info, config_summary, results)
    write_json(args.results_dir / f"engine-{engine_cfg.name}.json", report)
    markdown = render_engine_markdown(report)
    (args.results_dir / f"engine-{engine_cfg.name}.md").write_text(markdown, encoding="utf-8")
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
