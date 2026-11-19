"""These functions write the sentences about the conditions that every engine meets
in a server run, which are the load, the Java and Narsil heaps inside the memory cap, and the
path through which Narsil searches vector graphs. Each sentence comes from a value
that the results record. Where an older run lacks a value, its sentence stays out."""

from __future__ import annotations

from render import and_join, dataset_name, engine_name, gibibytes, integer

NATIVE_VECTOR_SEARCH = "native"
WASM_VECTOR_SEARCH = "wasm"
SINGLE_SERVER_LABEL = "Narsil"

_SHARED_MACHINE_SENTENCES = (
    "The load generator shares the machine with the engine under test, so its client processes take CPU time "
    "that the engine could otherwise use. The harness measures every engine under that same arrangement."
)


def _placement_sentences(throughput: dict, environment: dict) -> str:
    if not isinstance(environment.get("engine_machine"), dict):
        return _SHARED_MACHINE_SENTENCES
    processes = throughput.get("client_processes")
    spread = (
        f", and it spreads the clients across {integer(processes)} processes"
        if isinstance(processes, int) and processes > 0
        else ""
    )
    return (
        "The load generator works on a separate machine from the engine under test, so its client processes take "
        f"no CPU time from the engine{spread}. The harness measures every engine under that same arrangement."
    )


def load_sentence(config: dict, environment: dict) -> str:
    throughput = config.get("throughput") or {}
    levels = throughput.get("concurrency") or []
    passes = throughput.get("passes")
    if not levels:
        return "The harness recorded no concurrency sweep."
    level_text = and_join([integer(level) for level in levels])
    placement = _placement_sentences(throughput, environment)
    if isinstance(passes, int) and passes > 1:
        return (
            f"The harness measures throughput at {level_text} concurrent clients, with one pass per level and "
            f"{integer(passes)} passes at each engine's peak level. The tables report the median peak pass "
            f"with a 95% bootstrap interval. {placement}"
        )
    return (
        f"The harness measures throughput at {level_text} concurrent clients, with one pass per level. "
        f"{placement}"
    )


def _load_settles(comparison: dict) -> list[tuple[dict, str, dict]]:
    found = []
    for track in comparison.get("tracks") or []:
        for dataset in track.get("datasets") or []:
            for row in dataset.get("rows") or []:
                settle = (row.get("operational") or {}).get("load_settle")
                if isinstance(settle, dict) and isinstance(settle.get("waited_seconds"), (int, float)):
                    found.append((row, dataset.get("dataset_id") or "", settle))
    return found


def settle_sentence(comparison: dict) -> str:
    settles = _load_settles(comparison)
    if not settles:
        return ""
    rule = settles[0][2]
    row, dataset_id, longest = max(settles, key=lambda entry: entry[2]["waited_seconds"])
    busy = sorted(
        {f"{engine_name(entry[0].get('engine') or '')} on {dataset_name(entry[1])}" for entry in settles if not entry[2].get("settled")}
    )
    sentence = (
        f" After it loads each large dataset, the harness waits until the engine uses less than "
        f"{rule.get('quiet_engine_cores')} cores for {integer(rule.get('quiet_seconds'))} seconds in a row, so that the "
        "merges, graph builds, and index copies that an engine starts after a load finish before any measurement. "
        f"The longest wait was {integer(longest['waited_seconds'])} seconds, for {engine_name(row.get('engine') or '')} "
        f"on {dataset_name(dataset_id)}."
    )
    if busy:
        sentence += (
            f" The harness stopped waiting after {integer(rule.get('timeout_seconds'))} seconds for "
            f"{and_join(busy)}, which stayed busy until then."
        )
    return sentence


def java_heap_sentence(engines: list[dict]) -> str:
    heaps = []
    for engine in engines:
        heap = (engine.get("build_identity") or {}).get("jvm_heap_max_bytes")
        if isinstance(heap, (int, float)):
            heaps.append(f"{engine_name(engine.get('name') or '')} reports a {gibibytes(heap)} heap")
    if not heaps:
        return ""
    return f" Each Java engine divides that cap between its heap and the memory outside it. {and_join(heaps)}."


def narsil_heap_sentence(narsil: dict, label: str = SINGLE_SERVER_LABEL) -> str:
    heap = (narsil.get("server_setup") or {}).get("heap_limit_bytes")
    if not isinstance(heap, (int, float)):
        return ""
    return f" {_server_subject(label)} reports that its V8 heap can grow to {gibibytes(heap)} inside that cap."


def _server_subject(label: str) -> str:
    return f"{label}'s server" if label == SINGLE_SERVER_LABEL else f"The {label} server"


def narsil_vector_search_bullets(narsil: dict, label: str = SINGLE_SERVER_LABEL) -> list[str]:
    path = (narsil.get("build_identity") or {}).get("vector_search")
    subject = _server_subject(label)
    if path == NATIVE_VECTOR_SEARCH:
        return [
            f"- **{label} vector search.** {subject} reports that it searches vector graphs through its native "
            "search core in C, which npm installs with the package on Node.js for macOS, Linux, and Windows."
        ]
    if path == WASM_VECTOR_SEARCH:
        return [
            f"- **{label} vector search.** {subject} reports that it searches vector graphs through WebAssembly, "
            "so these figures exclude its native search core."
        ]
    return []
