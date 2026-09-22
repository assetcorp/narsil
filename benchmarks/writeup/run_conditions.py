"""These functions write the sentences about the conditions that every engine meets
in a server run, which are the load, the Java heaps inside the memory cap, and the
path through which Narsil searches vector graphs. Each sentence comes from a value
that the results record. Where an older run lacks a value, its sentence stays out."""

from __future__ import annotations

from render import and_join, decimal, engine_name, integer

NATIVE_VECTOR_SEARCH = "native"
WASM_VECTOR_SEARCH = "wasm"

_SHARED_MACHINE_SENTENCES = (
    "The load generator shares the machine with the engine under test, so its client processes take CPU time "
    "that the engine could otherwise use. The harness measures every engine under that same arrangement."
)


def load_sentence(config: dict) -> str:
    throughput = config.get("throughput") or {}
    levels = throughput.get("concurrency") or []
    passes = throughput.get("passes")
    if not levels:
        return "The harness recorded no concurrency sweep."
    level_text = and_join([integer(level) for level in levels])
    if isinstance(passes, int) and passes > 1:
        return (
            f"The harness measures throughput at {level_text} concurrent clients, with one pass per level and "
            f"{integer(passes)} passes at each engine's peak level. The tables report the median peak pass "
            f"with a 95% bootstrap interval. {_SHARED_MACHINE_SENTENCES}"
        )
    return (
        f"The harness measures throughput at {level_text} concurrent clients, with one pass per level. "
        f"{_SHARED_MACHINE_SENTENCES}"
    )


def java_heap_sentence(engines: list[dict]) -> str:
    heaps = []
    for engine in engines:
        heap = (engine.get("build_identity") or {}).get("jvm_heap_max_bytes")
        if isinstance(heap, (int, float)):
            heaps.append(f"{engine_name(engine.get('name') or '')} reports a {decimal(heap / 1e9, 1)} GB heap")
    if not heaps:
        return ""
    return f" Each Java engine divides that cap between its heap and the memory outside it. {and_join(heaps)}."


def narsil_vector_search_bullets(narsil: dict) -> list[str]:
    path = (narsil.get("build_identity") or {}).get("vector_search")
    if path == NATIVE_VECTOR_SEARCH:
        return [
            "- **Narsil vector search.** Narsil's server reports that it searches vector graphs through its native "
            "search core in C, which npm installs with the package on Node.js for macOS, Linux, and Windows."
        ]
    if path == WASM_VECTOR_SEARCH:
        return [
            "- **Narsil vector search.** Narsil's server reports that it searches vector graphs through WebAssembly, "
            "so these figures exclude its native search core."
        ]
    return []
