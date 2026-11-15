from __future__ import annotations

import copy
from dataclasses import replace

from render import engine_name
from sources import Source, load_server_best_config_source, load_server_source

NARSIL_TYPESCRIPT = "narsil"
NARSIL_RUST = "narsil-rust"
NARSIL_SERVERS = (NARSIL_TYPESCRIPT, NARSIL_RUST)
NARSIL_SERVER_NAMES = {NARSIL_TYPESCRIPT: "Narsil TypeScript", NARSIL_RUST: "Narsil Rust"}
DISPLAY_NAME_FIELD = "display_name"
UNMEASURED_FIELD = "unmeasured"
NOT_MEASURED_TEXT = "not measured yet"


def is_narsil_server(engine: object) -> bool:
    return engine in NARSIL_SERVERS


def is_unmeasured(entry: dict) -> bool:
    return entry.get(UNMEASURED_FIELD) is True


def engine_entry(engines: list[dict], name: str) -> dict | None:
    return next((engine for engine in engines if engine.get("name") == name), None)


def engine_label(engines: list[dict], name: str) -> str:
    engine = engine_entry(engines, name)
    return (engine or {}).get(DISPLAY_NAME_FIELD) or engine_name(name)


def narsil_row(rows: list[dict]) -> dict | None:
    return next((row for row in rows if is_narsil_server(row.get("engine")) and not is_unmeasured(row)), None)


def comparison_rows(comparison: dict) -> list[dict]:
    return [
        row
        for entry in comparison.get("tracks") or []
        for dataset in entry.get("datasets") or []
        for row in dataset.get("rows") or []
    ]


def narsil_servers_in(comparison: dict | None) -> set[str]:
    if comparison is None:
        return set()
    names = {engine.get("name") for engine in comparison.get("engines") or []}
    names.update(row.get("engine") for row in comparison_rows(comparison))
    return {name for name in NARSIL_SERVERS if name in names}


def _placeholder(name: str, key: str) -> dict:
    return {key: name, DISPLAY_NAME_FIELD: NARSIL_SERVER_NAMES[name], UNMEASURED_FIELD: True}


def _with_every_server(entries: list[dict], key: str) -> list[dict]:
    first = next((index for index, entry in enumerate(entries) if is_narsil_server(entry.get(key))), len(entries))
    found = {entry.get(key): entry for entry in entries if is_narsil_server(entry.get(key))}
    servers = []
    for name in NARSIL_SERVERS:
        entry = found.get(name) or _placeholder(name, key)
        entry[DISPLAY_NAME_FIELD] = NARSIL_SERVER_NAMES[name]
        servers.append(entry)
    others = [entry for entry in entries if not is_narsil_server(entry.get(key))]
    return [*others[:first], *servers, *others[first:]]


def with_every_narsil_server(comparison: dict) -> dict:
    result = copy.deepcopy(comparison)
    engines = list(result.get("engines") or [])
    recorded = {row.get("engine") for row in comparison_rows(result) if not is_unmeasured(row)}
    for name in NARSIL_SERVERS:
        if name in recorded and engine_entry(engines, name) is None:
            engines.append({"name": name})
    result["engines"] = _with_every_server(engines, "name")
    for entry in result.get("tracks") or []:
        for dataset in entry.get("datasets") or []:
            dataset["rows"] = _with_every_server(list(dataset.get("rows") or []), "engine")
    return result


def load_server_sources(include_every_narsil_server: bool = False) -> tuple[Source, Source | None]:
    server = load_server_source()
    best = load_server_best_config_source()
    present = narsil_servers_in(server.data) | narsil_servers_in(best.data if best is not None else None)
    if not include_every_narsil_server and NARSIL_RUST not in present:
        return server, best
    widened_best = replace(best, data=with_every_narsil_server(best.data)) if best is not None else None
    return replace(server, data=with_every_narsil_server(server.data)), widened_best
