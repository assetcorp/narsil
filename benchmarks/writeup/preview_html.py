from __future__ import annotations

import base64
import html
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote, urlsplit

from headline_section import REPOSITORY_FILE_URL

FIGURE_MEDIA_TYPES = {".svg": "image/svg+xml", ".png": "image/png"}
CONTENT_TAGS = frozenset((
    "a", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre", "code", "em", "strong",
    "blockquote", "table", "thead", "tbody", "tr", "th", "td", "img", "br", "hr", "details", "summary", "div", "span",
))
VOID_TAGS = frozenset(("img", "br", "hr"))

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
    target = urlsplit(source)
    relative = PurePosixPath(unquote(target.path))
    media_type = FIGURE_MEDIA_TYPES.get(relative.suffix)
    if target.scheme or target.netloc or relative.is_absolute() or ".." in relative.parts or "\\" in source or media_type is None:
        raise SystemExit(f"benchmark preview: refusing the figure path {source!r}")
    for root in roots:
        candidate = root.joinpath(*relative.parts).resolve()
        if not candidate.is_relative_to(root.resolve()):
            raise SystemExit(f"benchmark preview: refusing the figure path {source!r}")
        if candidate.is_file():
            encoded = base64.b64encode(candidate.read_bytes()).decode("ascii")
            return f"data:{media_type};base64,{encoded}"
    raise SystemExit(f"benchmark preview: the page embeds {source}, but no chart drawing produced it")


def _absolute_link(target: str) -> str:
    if any(ord(char) < 32 for char in target) or "\\" in target:
        return "#"
    parsed = urlsplit(target)
    if parsed.scheme:
        return target if parsed.scheme.lower() in ("http", "https", "mailto") else "#"
    if target.startswith("//"):
        return "https:" + target
    if not target or target.startswith("#"):
        return target
    path = PurePosixPath(unquote(parsed.path).removeprefix("/"))
    if ".." in path.parts:
        return "#"
    suffix = f"?{parsed.query}" if parsed.query else ""
    suffix += f"#{parsed.fragment}" if parsed.fragment else ""
    return REPOSITORY_FILE_URL + "/" + quote(str(path), safe="/") + suffix


class _Content(HTMLParser):
    def __init__(self, roots: tuple[Path, ...]):
        super().__init__(convert_charrefs=True)
        self.roots = roots
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in CONTENT_TAGS:
            return
        values = dict(attrs)
        kept = {}
        for key in ("title", "alt", "width", "height", "colspan", "rowspan"):
            if values.get(key) is not None:
                kept[key] = values[key]
        if tag == "a" and values.get("href") is not None:
            kept["href"] = _absolute_link(values["href"])
        if tag == "img":
            kept["src"] = _data_uri(values.get("src") or "", self.roots)
        alignment = values.get("style") or ""
        if tag in ("th", "td") and alignment in ("text-align:left", "text-align:right", "text-align:center"):
            kept["style"] = alignment
        attributes = "".join(f' {key}="{html.escape(value, quote=True)}"' for key, value in kept.items())
        self.parts.append(f"<{tag}{attributes}>")

    def handle_endtag(self, tag: str) -> None:
        if tag in CONTENT_TAGS and tag not in VOID_TAGS:
            self.parts.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        self.parts.append(html.escape(data, quote=False))


def render_content(rendered: str, roots: tuple[Path, ...]) -> str:
    parser = _Content(roots)
    parser.feed(rendered)
    parser.close()
    return "".join(parser.parts)


def _wrap_tables(rendered: str) -> str:
    return rendered.replace("<table>", '<div class="table-scroll"><table>').replace("</table>", "</table></div>")


def preview_document(run_id: str, headline: str, page: str) -> str:
    notice = (
        f"<p><strong>Preview.</strong> This page renders BENCHMARKS.md from run <code>{html.escape(run_id)}</code> "
        "with a row for every Narsil server in every server table and chart.</p>"
        "<p>A row that reads not measured yet holds no figure, because this comparison has no measurement "
        "for that server on that dataset.</p>"
    )
    return "\n".join([
        "<!doctype html>",
        '<html lang="en-GB">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">',
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
