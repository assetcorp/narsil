from __future__ import annotations

from collections.abc import Sequence

BEST_MARK = "\\*"


def best_text(candidates: Sequence[tuple[float | None, str]], higher_is_better: bool) -> str | None:
    present = [(value, text) for value, text in candidates if value is not None]
    if len(present) < 2 or len({text for _, text in present}) < 2:
        return None
    pick = max if higher_is_better else min
    return pick(present, key=lambda candidate: candidate[0])[1]


def marked(text: str, best: str | None, eligible: bool = True) -> str:
    if not eligible or best is None or text != best:
        return text
    return f"**{text}**{BEST_MARK}"
