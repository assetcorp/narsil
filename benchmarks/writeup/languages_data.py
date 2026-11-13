from __future__ import annotations

ENGINE_ORDER = ["typescript", "rust", "go"]
ENGINE_LABELS = {"typescript": "TypeScript", "rust": "Rust", "go": "Go"}
PHASES = [("keyword", "keyword", "Keyword search"), ("vector", "vector", "Vector search"), ("vector", "hybrid", "Hybrid search")]


def language_label(engine: str) -> str:
    return ENGINE_LABELS.get(engine, engine)


def dig(node: object, *path: str) -> object:
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def measurements(results: dict) -> dict[tuple[str, str, int], dict]:
    found: dict[tuple[str, str, int], dict] = {}
    for entry in results.get("measurements") or []:
        if isinstance(entry, dict):
            found[(entry.get("engine"), entry.get("workload"), entry.get("threads"))] = entry
    return found


def engines_in(results: dict) -> list[str]:
    present = results.get("engines") or {}
    return [engine for engine in ENGINE_ORDER if engine in present]


def thread_counts(results: dict) -> list[int]:
    return [count for count in results.get("threadCounts") or [] if isinstance(count, int)]


def phase_summary(found: dict[tuple[str, str, int], dict], engine: str, workload: str, phase: str, threads: int) -> object:
    return dig(found.get((engine, workload, threads)), "phases", phase)
