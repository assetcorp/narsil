"""Generate the numbers in BENCHMARKS.md from the latest recorded run of each suite.

The page is hand-written prose with generated regions marked by HTML comments. This
tool replaces the text between each `<!-- BENCH:<id> START -->` and its matching END
marker, so the narrative stays human while every table and figure comes from the
recorded runs. With `--check` it verifies that the committed page matches a fresh
generation, that every figure the page embeds is committed, and, where matplotlib is
installed, that every committed figure matches a fresh drawing of its run, exiting
non-zero on any difference, which is what continuous integration runs.

    python3 benchmarks/writeup/generate.py            # rewrite BENCHMARKS.md in place
    python3 benchmarks/writeup/generate.py --check     # fail if the page or a figure is out of date
"""

from __future__ import annotations

import re
import sys
import tempfile
from pathlib import Path

from inprocess_section import inprocess_blocks
from server_section import server_blocks
from sources import Source, load_inprocess_source, load_server_best_config_source, load_server_source, repo_root

_IMAGE_SOURCE = re.compile(r'<img src="([^"]+)"')


def _inject(text: str, blocks: dict[str, str]) -> str:
    for block_id, content in blocks.items():
        start = f"<!-- BENCH:{block_id} START -->"
        end = f"<!-- BENCH:{block_id} END -->"
        start_at = text.find(start)
        end_at = text.find(end)
        if start_at == -1 or end_at == -1 or end_at < start_at:
            raise SystemExit(f"benchmark writeup: markers for '{block_id}' are missing or malformed in BENCHMARKS.md")
        head = text[: start_at + len(start)]
        tail = text[end_at:]
        text = f"{head}\n{content}\n{tail}"
    return text


def _missing_figures(page_text: str, root: Path) -> list[str]:
    return sorted({path for path in _IMAGE_SOURCE.findall(page_text) if not (root / path).is_file()})


def _stale_figures(root: Path, server: Source, best: Source | None, inprocess: Source) -> list[str] | None:
    try:
        from charts import render
    except ImportError:
        return None
    stale: list[str] = []
    with tempfile.TemporaryDirectory() as scratch:
        scratch_root = Path(scratch)
        for drawn in render(scratch_root, server, best, inprocess):
            relative = drawn.relative_to(scratch_root)
            committed = root / relative
            if not committed.is_file() or committed.read_bytes() != drawn.read_bytes():
                stale.append(str(relative))
    return sorted(stale)


def main(argv: list[str]) -> int:
    check = "--check" in argv
    root = repo_root()
    path = root / "BENCHMARKS.md"
    current = path.read_text(encoding="utf-8")
    server = load_server_source()
    best = load_server_best_config_source()
    inprocess = load_inprocess_source()
    blocks = {**server_blocks(server, best), **inprocess_blocks(inprocess)}
    updated = _inject(current, blocks)

    if check:
        if updated != current:
            sys.stderr.write(
                "BENCHMARKS.md is out of date with the latest benchmark runs. "
                "Run `python3 benchmarks/writeup/generate.py` and commit the result.\n"
            )
            return 1
        missing = _missing_figures(updated, root)
        if missing:
            sys.stderr.write(
                f"BENCHMARKS.md embeds {len(missing)} figure(s) that are not committed, starting with {missing[0]}. "
                "Run `python3 benchmarks/writeup/charts.py` and commit the result.\n"
            )
            return 1
        stale = _stale_figures(root, server, best, inprocess)
        if stale is None:
            sys.stdout.write("BENCHMARKS.md is up to date with the latest runs; matplotlib is not installed, so the figures were checked for presence alone.\n")
            return 0
        if stale:
            sys.stderr.write(
                f"{len(stale)} figure(s) differ from a fresh drawing of their run, starting with {stale[0]}. "
                "Run `python3 benchmarks/writeup/charts.py` and commit the result.\n"
            )
            return 1
        sys.stdout.write("BENCHMARKS.md and every figure are up to date with the latest runs.\n")
        return 0

    if updated == current:
        sys.stdout.write("BENCHMARKS.md is already up to date.\n")
        return 0
    path.write_text(updated, encoding="utf-8")
    sys.stdout.write("BENCHMARKS.md regenerated from the latest runs.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
