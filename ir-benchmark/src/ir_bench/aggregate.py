from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .core.comparison import build_comparison, render_comparison_markdown
from .core.reporter import write_json
from .core.types import EQUAL_PRECISION, VECTOR_PROFILES


def _load_reports(results_dir: Path) -> list[dict]:
    reports = [json.loads(path.read_text(encoding="utf-8")) for path in sorted(results_dir.glob("engine-*.json"))]
    if not reports:
        raise SystemExit(f"no engine-*.json result files found in {results_dir}")
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
    parser.add_argument("--engines", default=None, help="comma-separated engine order for the tables")
    args = parser.parse_args(argv)

    order = [name.strip() for name in args.engines.split(",")] if args.engines else None
    reports = _load_reports(args.results_dir)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    wrote_any = False
    for profile in VECTOR_PROFILES:
        profile_reports = _ordered_for_profile(reports, profile, order)
        if not profile_reports:
            continue
        wrote_any = True
        comparison = build_comparison(profile_reports, profile)
        suffix = "" if profile == EQUAL_PRECISION else f"-{profile}"
        write_json(args.results_dir / f"comparison{suffix}-{stamp}.json", comparison)
        markdown = render_comparison_markdown(comparison)
        (args.results_dir / f"comparison{suffix}-{stamp}.md").write_text(markdown, encoding="utf-8")
        print(markdown, flush=True)
    if not wrote_any:
        raise SystemExit("no engine results matched a known vector profile")
    return 0


if __name__ == "__main__":
    sys.exit(main())
