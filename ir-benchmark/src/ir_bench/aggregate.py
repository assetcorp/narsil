from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .core.comparison import build_comparison, render_comparison_markdown
from .core.reporter import write_json, write_text_atomic
from .core.run_store import resolve_run_id_for_read, run_directory
from .core.types import EQUAL_PRECISION, VECTOR_PROFILES


def _load_reports(directory: Path) -> list[dict]:
    paths = sorted(directory.glob("engine-*.json"))
    if not paths:
        raise SystemExit(f"no engine-*.json result files found in {directory}")
    reports: list[dict] = []
    for path in paths:
        try:
            reports.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as exc:
            raise SystemExit(f"could not read engine result {path}: {exc}") from exc
    return reports


def _ordered_for_profile(reports: list[dict], profile: str, order: list[str] | None) -> list[dict]:
    found: dict[str, dict] = {}
    for report in reports:
        if (report.get("engine", {}).get("vector_profile") or EQUAL_PRECISION) != profile:
            continue
        name = report.get("engine", {}).get("name")
        if name:
            found[name] = report
    if not found:
        return []
    if order:
        names = [name for name in order if name in found]
    else:
        names = sorted(found, key=lambda n: (n != "narsil", n))
    return [found[name] for name in names]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Aggregate per-engine results into a cross-engine comparison.")
    parser.add_argument("--results-dir", type=Path, default=Path("results"))
    parser.add_argument(
        "--run-id",
        default=None,
        help="aggregate this run id (or $BENCH_RUN_ID); defaults to the latest run on disk",
    )
    parser.add_argument("--engines", default=None, help="comma-separated engine order for the tables")
    args = parser.parse_args(argv)

    order = [name.strip() for name in args.engines.split(",")] if args.engines else None
    try:
        run_id = resolve_run_id_for_read(args.results_dir, args.run_id)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    directory = run_directory(args.results_dir, run_id)
    reports = _load_reports(directory)

    wrote_any = False
    for profile in VECTOR_PROFILES:
        profile_reports = _ordered_for_profile(reports, profile, order)
        if not profile_reports:
            continue
        wrote_any = True
        comparison = build_comparison(profile_reports, profile)
        suffix = "" if profile == EQUAL_PRECISION else f"-{profile}"
        write_json(directory / f"comparison{suffix}.json", comparison)
        markdown = render_comparison_markdown(comparison)
        write_text_atomic(directory / f"comparison{suffix}.md", markdown)
        print(markdown, flush=True)
    if not wrote_any:
        raise SystemExit("no engine results matched a known vector profile")
    return 0


if __name__ == "__main__":
    sys.exit(main())
