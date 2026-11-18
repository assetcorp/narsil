from __future__ import annotations

from chart_data import track
from narsil_servers import (
    NARSIL_RUST,
    NARSIL_TYPESCRIPT,
    comparison_rows,
    engine_entry,
    engine_label,
    is_narsil_server,
    is_unmeasured,
    narsil_row,
)
from render import and_join, dataset_name, gibibytes, integer
from reruns import rerun_bullets
from run_conditions import (
    SINGLE_SERVER_LABEL,
    java_heap_sentence,
    load_sentence,
    narsil_heap_sentence,
    narsil_vector_search_bullets,
)
from sources import Source


def _date(source: Source) -> str:
    created = source.manifest.get("created_at") or ""
    return created[:10] if isinstance(created, str) else ""


def _dataset_phrases(track_entry: dict) -> list[str]:
    phrases = []
    for dataset in track_entry["datasets"]:
        rows = dataset["rows"]
        row = narsil_row(rows) or (rows[0] if rows else {})
        docs = (row.get("operational") or {}).get("documents_indexed")
        phrases.append(f"{dataset_name(dataset['dataset_id'])} ({integer(docs)} documents)")
    return phrases


def _vectors_sentence(config: dict) -> str:
    vectors = config.get("dataset_vectors") or {}
    if not vectors:
        return ""
    phrases = []
    for dataset_id, entry in vectors.items():
        provenance = (
            "read from a published dataset artifact pinned by its SHA-256"
            if entry.get("source") == "artifact"
            else "loaded and hash-verified through `ir_datasets`"
        )
        phrases.append(
            f"{dataset_name(dataset_id)} is {provenance}, with {entry.get('model')} vectors at "
            f"{integer(entry.get('dims'))} dimensions"
        )
    return " " + "; ".join(phrases) + "."


def _dataset_engines_sentence(config: dict, engines: list[dict]) -> str:
    mapping = config.get("dataset_engines") or {}
    phrases = [
        f"only {and_join([engine_label(engines, name) for name in names])} ran {dataset_name(dataset_id)}"
        for dataset_id, names in mapping.items()
        if isinstance(names, list) and names
    ]
    if not phrases:
        return ""
    return " " + "; ".join(phrases) + "."


def _threads_sentence(narsil: dict, label: str) -> str:
    setup = narsil.get("server_setup") or {}
    workers = setup.get("worker_threads")
    request_threads = setup.get("request_threads")
    scaled_out = setup.get("scaled_out_indexes")
    if not isinstance(workers, int) or not isinstance(request_threads, int) or not isinstance(scaled_out, list):
        return f"The harness recorded no worker copy configuration for {label} in this run."
    copies = (
        "the benchmark index scaled out across them"
        if scaled_out
        else "no index scaled out across them, so the main copy answered every query"
    )
    return (
        f"{label} started at the engine defaults, and the harness read {integer(workers)} worker threads, "
        f"{integer(request_threads)} request threads receiving requests, and {copies}."
    )


def _host(environment: dict) -> str:
    return (
        f"{environment.get('cpu_model') or 'an unspecified CPU'} and "
        f"{environment.get('os')} {environment.get('arch')}"
    )


def _machine_sentence(environment: dict, engines: list[dict]) -> str:
    """One machine sentence when every engine ran on the same host, and one clause
    per engine when the engines ran on their own machines and the fetch step merged
    their files into one comparison."""

    groups: dict[tuple, tuple[dict, list[str]]] = {}
    for engine in engines:
        if is_unmeasured(engine):
            continue
        env = engine.get("environment") or environment
        key = (env.get("machine_label"), env.get("cpu_model"), env.get("os"), env.get("arch"))
        groups.setdefault(key, (env, []))[1].append(engine_label(engines, engine.get("name") or ""))
    if len(groups) > 1:
        clauses = [
            f"{and_join(names)} on {env.get('machine_label') or 'an unlabelled machine'}, which reports {_host(env)}"
            for env, names in groups.values()
        ]
        return f"The engines ran on {integer(len(groups))} machines: {and_join(clauses)}."
    machine_label = environment.get("machine_label")
    if machine_label:
        return f"{machine_label} hosted this run, and it reports {_host(environment)}."
    return f"The host reports {_host(environment)}."


def _version(engine: dict) -> str:
    return (engine.get("build_identity") or {}).get("version") or engine.get("version") or "n/a"


def _measured_in(comparison: dict | None, name: str) -> bool:
    return comparison is not None and any(
        row.get("engine") == name and not is_unmeasured(row) for row in comparison_rows(comparison)
    )


def _unmeasured_sentence(engines: list[dict], unmeasured: list[dict], production: dict | None) -> str:
    elsewhere = [engine_label(engines, engine["name"]) for engine in unmeasured if _measured_in(production, engine["name"])]
    nowhere = [engine_label(engines, engine["name"]) for engine in unmeasured if not _measured_in(production, engine["name"])]
    sentence = ""
    if nowhere:
        sentence += (
            f" The harness has not measured {and_join(nowhere)} in this run, so every table and chart lists it as "
            "not measured yet."
        )
    if elsewhere:
        sentence += (
            f" The harness measured {and_join(elsewhere)} only under recommended production settings, so the "
            "equal-precision tables and charts list it as not measured yet."
        )
    return sentence


def _engines_bullet(engines: list[dict], production: dict | None) -> str:
    servers = [engine for engine in engines if is_narsil_server(engine.get("name"))]
    measured = [
        f"{engine_label(engines, engine['name'])} {_version(engine)}" for engine in servers if not is_unmeasured(engine)
    ]
    unmeasured = [engine for engine in servers if is_unmeasured(engine)]
    others = [
        f"{engine_label(engines, engine['name'])} {engine.get('version') or 'n/a'}"
        for engine in engines
        if not is_narsil_server(engine.get("name"))
    ]
    narsil = and_join([*measured, *(engine_label(engines, engine["name"]) for engine in unmeasured)])
    if measured and others:
        bullet = f"- **Engines.** The comparison runs {narsil} against {and_join(others)}, and every engine runs from a pinned image."
    else:
        participants = and_join([*measured, *others])
        bullet = f"- **Engines.** The comparison records {participants}." if participants else "- **Engines.** The harness recorded no engine metadata."
    return bullet + _unmeasured_sentence(engines, unmeasured, production)


def setup_block(source: Source, best: Source | None = None) -> str:
    comparison = source.data
    config = comparison.get("config") or {}
    environment = comparison.get("environment") or {}
    engines = comparison.get("engines") or []
    keyword = track(comparison, "keyword") or {"datasets": []}

    narsil = engine_entry(engines, NARSIL_TYPESCRIPT) or {}
    label = engine_label(engines, NARSIL_TYPESCRIPT) if narsil else SINGLE_SERVER_LABEL
    measured = narsil if narsil and not is_unmeasured(narsil) else engine_entry(engines, NARSIL_RUST) or {}
    build = measured.get("build_identity") or {}
    commit = (build.get("build_hash") or "")[:12] or "unknown"
    dirty = ", which sits ahead of the released version" if build.get("dirty") else ""
    cap = gibibytes(config.get("memory_cap_bytes"))

    return "\n".join([
        f"- **Run.** These figures come from run `{source.run_id}`, recorded on {_date(source)} from commit "
        f"`{commit}`{dirty}. The raw per-engine results and the full comparison are in "
        f"[the run report]({source.report_link}).",
        *rerun_bullets(comparison),
        *rerun_bullets(best.data if best is not None else None),
        f"- **Datasets.** The harness measured {and_join(_dataset_phrases(keyword))}.{_vectors_sentence(config)}"
        f"{_dataset_engines_sentence(config, engines)}",
        _engines_bullet(engines, best.data if best is not None else None),
        f"- **Equal conditions.** Every engine receives the same {cap} memory cap, the same run depth of "
        f"{integer(config.get('run_depth'))}, and the same run-file ordering. The harness tests one engine at a "
        f"time, so each engine has the machine to itself.{java_heap_sentence(engines)}"
        f"{narsil_heap_sentence(narsil, label)}",
        f"- **Load.** {load_sentence(config, environment)}",
        *([f"- **{label} threads.** {_threads_sentence(narsil, label)}"] if narsil and not is_unmeasured(narsil) else []),
        *narsil_vector_search_bullets(narsil, label),
        f"- **Machine.** {_machine_sentence(environment, engines)}",
        f"- **BM25 calibration.** Narsil indexes each corpus with BM25 k1={config.get('k1')} and b={config.get('b')}, "
        "the Anserini reference configuration.",
    ])
