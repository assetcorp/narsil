"""Generate the numbers in BENCHMARKS.md from the latest recorded run of each suite.

The page is hand-written prose with generated regions marked by HTML comments. This
tool replaces the text between each `<!-- BENCH:<id> START -->` and its matching END
marker, so the narrative stays human while every table, chart, and figure comes from
the recorded runs. With `--check` it verifies the committed page matches a fresh
generation and exits non-zero on any drift, which is what continuous integration runs.

    python3 benchmarks/writeup/generate.py            # rewrite BENCHMARKS.md in place
    python3 benchmarks/writeup/generate.py --check     # fail if the page is out of date
"""

from __future__ import annotations

import sys

from inprocess_section import inprocess_blocks
from server_section import server_blocks
from sources import load_inprocess_source, load_server_source, repo_root


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


def main(argv: list[str]) -> int:
    check = "--check" in argv
    path = repo_root() / "BENCHMARKS.md"
    current = path.read_text(encoding="utf-8")
    blocks = {**server_blocks(load_server_source()), **inprocess_blocks(load_inprocess_source())}
    updated = _inject(current, blocks)

    if check:
        if updated != current:
            sys.stderr.write(
                "BENCHMARKS.md is out of date with the latest benchmark runs. "
                "Run `python3 benchmarks/writeup/generate.py` and commit the result.\n"
            )
            return 1
        sys.stdout.write("BENCHMARKS.md is up to date with the latest runs.\n")
        return 0

    if updated == current:
        sys.stdout.write("BENCHMARKS.md is already up to date.\n")
        return 0
    path.write_text(updated, encoding="utf-8")
    sys.stdout.write("BENCHMARKS.md regenerated from the latest runs.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
