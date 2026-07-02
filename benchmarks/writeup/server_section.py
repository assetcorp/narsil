"""Build the search-server section of the writeup from the server suite's comparison.

The blocks carry every number and ranking, so the surrounding prose in BENCHMARKS.md
can stay qualitative and never drift. Quality metrics come from `metrics`, throughput
from the single concurrency level the suite records, and the matched-recall operating
point from `operating_point`.
"""

from __future__ import annotations

from render import and_join, bar_chart, dataset_name, decimal, engine_name, integer, table
from sources import Source


def _date(source: Source) -> str:
    created = source.manifest.get("created_at") or ""
    return created[:10] if isinstance(created, str) else ""


def _engine(engines: list[dict], name: str) -> dict | None:
    return next((engine for engine in engines if engine.get("name") == name), None)


def _narsil_row(rows: list[dict]) -> dict | None:
    return next((row for row in rows if row.get("engine") == "narsil"), None)


def _metric(row: dict, key: str) -> float | None:
    value = (row.get("metrics") or {}).get(key)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _qps(row: dict) -> float | None:
    levels = (row.get("throughput") or {}).get("levels") or []
    value = levels[0].get("qps") if levels else None
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _client_bound(row: dict) -> bool:
    levels = (row.get("throughput") or {}).get("levels") or []
    return bool(levels and levels[0].get("client_bound"))


def _track(comparison: dict, name: str) -> dict | None:
    return next((track for track in comparison.get("tracks", []) if track.get("track") == name), None)


def _ndcg_bars(rows: list[dict]) -> str:
    entries = []
    for row in rows:
        value = _metric(row, "ndcg_cut_10")
        if value is not None:
            entries.append((engine_name(row["engine"]), value, decimal(value, 4)))
    return bar_chart(entries)


def _qps_bars(rows: list[dict]) -> str:
    entries = []
    for row in rows:
        value = _qps(row)
        if value is not None:
            entries.append((engine_name(row["engine"]), value, f"{integer(value)} QPS"))
    return bar_chart(entries)


def _quality_table(rows: list[dict]) -> str:
    ordered = sorted(rows, key=lambda row: _metric(row, "ndcg_cut_10") or -1.0, reverse=True)
    body = []
    for row in ordered:
        qps_cell = integer(_qps(row))
        if _client_bound(row):
            qps_cell += " (client-limited)"
        body.append([
            engine_name(row["engine"]),
            decimal(_metric(row, "ndcg_cut_10"), 4),
            decimal(_metric(row, "recall_100"), 4),
            decimal(_metric(row, "map"), 4),
            decimal(_metric(row, "recip_rank"), 4),
            qps_cell,
        ])
    headers = ["Engine", "nDCG@10", "Recall@100", "MAP", "MRR", "Peak QPS"]
    return table(headers, ["left", "right", "right", "right", "right", "right"], body)


def _quality_track_block(track: dict) -> str:
    chunks: list[str] = []
    for dataset in track["datasets"]:
        name = dataset_name(dataset["dataset_id"])
        rows = dataset["rows"]
        chunks.append(f"nDCG@10 on {name}, higher is better:")
        chunks.append(_ndcg_bars(rows))
        chunks.append(f"Peak throughput on {name}, queries per second, higher is better:")
        chunks.append(_qps_bars(rows))
        chunks.append(_quality_table(rows))
    return "\n\n".join(chunks)


def _vector_table(rows: list[dict]) -> str:
    ordered = sorted(rows, key=lambda row: _qps(row) or -1.0, reverse=True)
    body = []
    for row in ordered:
        point = row.get("operating_point") or {}
        knob = point.get("knob")
        value = point.get("chosen_value")
        knob_cell = f"{knob} {value}" if knob is not None and value is not None else "n/a"
        body.append([
            engine_name(row["engine"]),
            knob_cell,
            decimal(point.get("achieved_recall"), 4),
            integer(_qps(row)),
        ])
    headers = ["Engine", "Search effort", "ANN recall@10", "Peak QPS"]
    return table(headers, ["left", "left", "right", "right"], body)


def _vector_block(track: dict, config: dict) -> str:
    target = decimal(config.get("recall_target"), 2)
    chunks: list[str] = []
    for dataset in track["datasets"]:
        name = dataset_name(dataset["dataset_id"])
        rows = dataset["rows"]
        narsil = _narsil_row(rows)
        ndcg = decimal(_metric(narsil, "ndcg_cut_10"), 4) if narsil else "n/a"
        recall = decimal(_metric(narsil, "recall_100"), 4) if narsil else "n/a"
        chunks.append(
            f"On {name}, every engine tunes its search effort to reach ann_recall@10 of at least "
            f"{target} against the exact neighbours, and each returns the same ranking, so nDCG@10 is "
            f"{ndcg} and Recall@100 is {recall} across the field."
        )
        chunks.append(f"Peak throughput on {name} at matched recall, queries per second, higher is better:")
        chunks.append(_qps_bars(rows))
        chunks.append(_vector_table(rows))
    return "\n\n".join(chunks)


def _dataset_phrases(track: dict) -> list[str]:
    phrases = []
    for dataset in track["datasets"]:
        rows = dataset["rows"]
        row = _narsil_row(rows) or (rows[0] if rows else {})
        docs = (row.get("operational") or {}).get("documents_indexed")
        phrases.append(f"{dataset_name(dataset['dataset_id'])} ({integer(docs)} documents)")
    return phrases


def _setup_block(source: Source) -> str:
    comparison = source.data
    config = comparison.get("config") or {}
    environment = comparison.get("environment") or {}
    engines = comparison.get("engines") or []
    keyword = _track(comparison, "keyword") or {"datasets": []}

    narsil = _engine(engines, "narsil") or {}
    build = narsil.get("build_identity") or {}
    commit = (build.get("build_hash") or "")[:12] or "unknown"
    dirty = ", with uncommitted changes" if build.get("dirty") else ""
    others = [
        f"{engine_name(engine['name'])} {engine.get('version') or 'n/a'}"
        for engine in engines
        if engine.get("name") != "narsil"
    ]

    cap = decimal((config.get("memory_cap_bytes") or 0) / 1e9, 1)
    narsil_version = build.get("version") or narsil.get("version") or "n/a"
    machine_label = environment.get("machine_label")
    host = (
        f"{environment.get('cpu_model') or 'an unspecified CPU'} and "
        f"{environment.get('os')} {environment.get('arch')}"
    )
    machine = (
        f"The run executed on {machine_label}, which reports {host}."
        if machine_label
        else f"The run host reports {host}."
    )

    return "\n".join([
        f"- **Run.** These figures come from run `{source.run_id}`, recorded on {_date(source)} from commit "
        f"`{commit}`{dirty}. The raw per-engine results and the full comparison are in "
        f"[the run report]({source.report_link}).",
        f"- **Datasets.** The run covers {and_join(_dataset_phrases(keyword))}, each loaded and hash-verified "
        "through `ir_datasets`.",
        f"- **Engines.** The comparison runs Narsil {narsil_version} against {and_join(others)}, "
        "and every engine runs from a pinned image.",
        f"- **Equal conditions.** Every engine receives the same {cap} GB memory cap, the same run depth of "
        f"{integer(config.get('run_depth'))}, and the same run-file ordering, and the engines run one at a time so "
        "latency never contends.",
        f"- **Machine.** {machine}",
        f"- **BM25 calibration.** Narsil indexes each corpus with BM25 k1={config.get('k1')} and b={config.get('b')}, "
        "the Anserini reference configuration.",
    ])


def server_blocks(source: Source) -> dict[str, str]:
    comparison = source.data
    config = comparison.get("config") or {}
    keyword = _track(comparison, "keyword")
    vector = _track(comparison, "vector")
    hybrid = _track(comparison, "hybrid")
    return {
        "server-setup": _setup_block(source),
        "server-keyword": _quality_track_block(keyword) if keyword else "No keyword results were recorded.",
        "server-vector": _vector_block(vector, config) if vector else "No vector results were recorded.",
        "server-hybrid": _quality_track_block(hybrid) if hybrid else "No hybrid results were recorded.",
    }
