"""Render the benchmark page, with its figures, into one self-contained HTML file.

The preview gives every Narsil server a row in every server table and chart, and a
server that no recorded run has measured shows as not measured yet. It writes only
the output file, so the committed page and the committed figures stay as they are.

    python3 benchmarks/writeup/preview.py --output /path/to/benchmarks-preview.html
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

from charts import render
from generate import BENCHMARKS_PAGE, generated_pages
from headline_section import README_TARGETS, readme_blocks
from markdown_it import MarkdownIt
from narsil_servers import load_server_sources
from preview_html import preview_document, render_content
from sources import load_inprocess_source, load_languages_source, repo_root

OUTPUT_SUFFIX = ".html"


def _arguments(argv: list[str]) -> Path:
    parser = argparse.ArgumentParser(description="Render a preview of BENCHMARKS.md into one HTML file.")
    parser.add_argument("--output", required=True, type=Path, help="the HTML file to write")
    output = parser.parse_args(argv).output
    if output.suffix != OUTPUT_SUFFIX:
        parser.error(f"--output must name a {OUTPUT_SUFFIX} file")
    if output.is_dir():
        parser.error("--output must name a file, not a directory")
    return output


def _write(output: Path, document: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=output.parent, prefix=f".{output.name}.", suffix=".partial", delete=False
        ) as handle:
            partial = Path(handle.name)
            handle.write(document)
            handle.flush()
            os.fsync(handle.fileno())
        partial.replace(output)
    finally:
        if partial is not None:
            partial.unlink(missing_ok=True)


def main(argv: list[str]) -> int:
    output = _arguments(argv).resolve()
    root = repo_root()
    server, best = load_server_sources(include_every_narsil_server=True)
    inprocess = load_inprocess_source()
    languages = load_languages_source()
    page = generated_pages(root, server, best, inprocess, languages)[BENCHMARKS_PAGE][1]
    headline = readme_blocks(server, README_TARGETS[0], best)["headline"]
    markdown = MarkdownIt("commonmark", {"html": True}).enable("table")
    with tempfile.TemporaryDirectory() as scratch:
        drawn = Path(scratch)
        render(drawn, server, best, inprocess, languages)
        page_html = render_content(markdown.render(page), (drawn, root))
        headline_html = render_content(markdown.render(headline), (drawn, root))
    _write(output, preview_document(server.run_id, headline_html, page_html))
    sys.stdout.write(f"Wrote the benchmark page preview to {output}.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
