from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .core.comparison import build_comparison, render_comparison_markdown
from .core.reporter import write_json


def _load_reports(results_dir: Path, order: list[str] | None) -> list[dict]:
    found: dict[str, dict] = {}
    for path in sorted(results_dir.glob("engine-*.json")):
        report = json.loads(path.read_text(encoding="utf-8"))
        name = report.get("engine", {}).get("name")
        if name:
            found[name] = report
    if not found:
        raise SystemExit(f"no engine-*.json result files found in {results_dir}")
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
    reports = _load_reports(args.results_dir, order)

    comparison = build_comparison(reports)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    write_json(args.results_dir / f"comparison-{stamp}.json", comparison)
    markdown = render_comparison_markdown(comparison)
    (args.results_dir / f"comparison-{stamp}.md").write_text(markdown, encoding="utf-8")
    print(markdown, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
