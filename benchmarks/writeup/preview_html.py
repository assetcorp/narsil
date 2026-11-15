from __future__ import annotations

import base64
import html
import re
from pathlib import Path, PurePosixPath

from generate import IMAGE_SOURCE
from headline_section import REPOSITORY_FILE_URL

FIGURE_MEDIA_TYPES = {".svg": "image/svg+xml", ".png": "image/png"}
_LINK_TARGET = re.compile(r'href="([^"]*)"')
_ABSOLUTE_TARGET = re.compile(r"^(?:[A-Za-z][A-Za-z0-9+.-]*:|#|//)")

PAGE_STYLE = """
:root {
  --page-background: #ffffff;
  --page-text: #1f2328;
  --page-muted: #59636e;
  --page-border: #d1d9e0;
  --page-stripe: #f6f8fa;
  --page-link: #0969da;
  --notice-background: #fff8c5;
  --notice-border: #d4a72c;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --page-background: #0d1117;
    --page-text: #f0f6fc;
    --page-muted: #9198a1;
    --page-border: #3d444d;
    --page-stripe: #151b23;
    --page-link: #4493f8;
    --notice-background: #272115;
    --notice-border: #9e6a03;
  }
}
:root[data-theme="dark"] {
  --page-background: #0d1117;
  --page-text: #f0f6fc;
  --page-muted: #9198a1;
  --page-border: #3d444d;
  --page-stripe: #151b23;
  --page-link: #4493f8;
  --notice-background: #272115;
  --notice-border: #9e6a03;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page-background);
  color: var(--page-text);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
}
main { max-width: 900px; margin: 0 auto; padding: 32px 16px 64px; }
a { color: var(--page-link); }
h1, h2, h3 { line-height: 1.25; margin: 24px 0 16px; }
h1, h2 { padding-bottom: 0.3em; border-bottom: 1px solid var(--page-border); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 85%; padding: 0.2em 0.4em;
  border-radius: 6px; background: var(--page-stripe); overflow-wrap: anywhere; }
pre { overflow-x: auto; padding: 16px; border-radius: 6px; background: var(--page-stripe); }
img { display: block; max-width: 100%; height: auto; margin: 16px 0; border-radius: 6px; background: #ffffff; }
.table-scroll { overflow-x: auto; margin: 16px 0; }
table { border-collapse: collapse; font-size: 14px; }
th, td { border: 1px solid var(--page-border); padding: 6px 13px; }
tr:nth-child(2n) { background: var(--page-stripe); }
.notice { padding: 12px 16px; border: 1px solid var(--notice-border); border-radius: 6px;
  background: var(--notice-background); }
.notice p { margin: 4px 0; }
.headline { padding: 4px 16px; border: 1px solid var(--page-border); border-radius: 6px; }
.label { color: var(--page-muted); font-size: 14px; margin: 24px 0 8px; }
"""


def _data_uri(source: str, roots: tuple[Path, ...]) -> str:
    relative = PurePosixPath(source)
    media_type = FIGURE_MEDIA_TYPES.get(relative.suffix)
    if relative.is_absolute() or ".." in relative.parts or media_type is None:
        raise SystemExit(f"benchmark preview: refusing the figure path {source!r}")
    for root in roots:
        candidate = root.joinpath(*relative.parts)
        if candidate.is_file():
            encoded = base64.b64encode(candidate.read_bytes()).decode("ascii")
            return f"data:{media_type};base64,{encoded}"
    raise SystemExit(f"benchmark preview: the page embeds {source}, but no chart drawing produced it")


def embed_figures(rendered: str, roots: tuple[Path, ...]) -> str:
    return IMAGE_SOURCE.sub(lambda match: f'<img src="{_data_uri(match.group(1), roots)}"', rendered)


def _absolute_link(match: re.Match[str]) -> str:
    target = html.unescape(match.group(1))
    if not target or _ABSOLUTE_TARGET.match(target):
        return match.group(0)
    path = target.removeprefix("./").removeprefix("/")
    return f'href="{html.escape(REPOSITORY_FILE_URL + "/" + path)}"'


def absolute_links(rendered: str) -> str:
    return _LINK_TARGET.sub(_absolute_link, rendered)


def _wrap_tables(rendered: str) -> str:
    return rendered.replace("<table>", '<div class="table-scroll"><table>').replace("</table>", "</table></div>")


def preview_document(run_id: str, headline: str, page: str) -> str:
    notice = (
        f"<p><strong>Preview.</strong> This page renders BENCHMARKS.md from run <code>{html.escape(run_id)}</code> "
        "with a row for every Narsil server in every server table and chart.</p>"
        "<p>A row that reads not measured yet holds no figure, because no recorded run measured that server.</p>"
    )
    return "\n".join([
        "<!doctype html>",
        '<html lang="en-GB">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>Benchmark page preview</title>",
        f"<style>{PAGE_STYLE}</style>",
        "</head>",
        "<body>",
        "<main>",
        f'<div class="notice">{notice}</div>',
        '<p class="label">README headline</p>',
        f'<div class="headline">{_wrap_tables(headline)}</div>',
        '<p class="label">BENCHMARKS.md</p>',
        _wrap_tables(page),
        "</main>",
        "</body>",
        "</html>",
        "",
    ])
