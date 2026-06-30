from __future__ import annotations

from .latency_report import client_summary, disclosure, server_summary
from .throughput_report import comparison_lines as throughput_lines
from .types import BEST_CONFIG, EQUAL_PRECISION, HYBRID, INTEGER_MS, KEYWORD, TRACKS, VECTOR

_INTEGER_MS_FLOOR_MS = 1.0

_PROFILE_TITLES = {
    EQUAL_PRECISION: "equal precision (every engine full float)",
    BEST_CONFIG: "best config (each engine's recommended production quantization)",
}


def build_comparison(reports: list[dict], profile: str = EQUAL_PRECISION) -> dict:
    engines = [
        {
            "name": r["engine"]["name"],
            "version": r["engine"].get("version"),
            "build_identity": r["engine"].get("build_identity"),
            "image_digest": r["engine"].get("image_digest"),
            "tracks": r["engine"].get("tracks", []),
            "keyword_setup": r["engine"].get("keyword_setup"),
        }
        for r in reports
    ]

    buckets: dict[tuple[str, str], list[dict]] = {}
    track_datasets: dict[str, list[str]] = {track: [] for track in TRACKS}
    dataset_identities: dict[str, dict] = {}
    for report in reports:
        engine_name = report["engine"]["name"]
        for result in report["datasets"]:
            track = result.get("track", KEYWORD)
            dataset_id = result["dataset_id"]
            identity = result.get("dataset_identity")
            if identity and dataset_id not in dataset_identities:
                dataset_identities[dataset_id] = identity
            key = (track, dataset_id)
            if key not in buckets:
                buckets[key] = []
                if dataset_id not in track_datasets.setdefault(track, []):
                    track_datasets[track].append(dataset_id)
            latency = result.get("latency", {})
            buckets[key].append(
                {
                    "engine": engine_name,
                    "metrics": result.get("metrics", {}),
                    "latency": latency,
                    "latency_server": server_summary(latency) or {},
                    "latency_client": client_summary(latency),
                    "server_time_resolution": latency.get("server_time_resolution"),
                    "server_time_disclosure": disclosure(latency),
                    "throughput": result.get("throughput"),
                    "operational": result.get("operational", {}),
                    "operating_point": result.get("operating_point"),
                    "setup": result.get("setup"),
                }
            )

    tracks_out = []
    for track in TRACKS:
        datasets = [
            {"dataset_id": dataset_id, "rows": buckets[(track, dataset_id)]}
            for dataset_id in track_datasets.get(track, [])
        ]
        if datasets:
            tracks_out.append({"track": track, "datasets": datasets})

    return {
        "environment": reports[0]["environment"] if reports else {},
        "config": reports[0]["config"] if reports else {},
        "profile": profile,
        "engines": engines,
        "dataset_identities": dataset_identities,
        "tracks": tracks_out,
    }


def _value(row: dict, group: str, key: str) -> float | None:
    value = row.get(group, {}).get(key)
    return float(value) if isinstance(value, (int, float)) else None


def _best(rows: list[dict], group: str, key: str, higher_is_better: bool) -> tuple[str | None, float | None]:
    candidates = [(r["engine"], _value(r, group, key)) for r in rows]
    candidates = [(name, value) for name, value in candidates if value is not None]
    if not candidates:
        return None, None
    chooser = max if higher_is_better else min
    return chooser(candidates, key=lambda pair: pair[1])


def _server_rankable(row: dict, key: str) -> float | None:
    """A server-side latency value eligible to win the fastest marker. An integer-ms
    engine whose value sits at or below the 1 ms resolution floor is below what it can
    measure, so it is not crowned fastest; it stays eligible once its reported time
    clears the floor, which happens on the larger corpora."""

    value = _value(row, "latency_server", key)
    if value is None:
        return None
    if row.get("server_time_resolution") == INTEGER_MS and value <= _INTEGER_MS_FLOOR_MS:
        return None
    return value


def _server_best(rows: list[dict], key: str) -> tuple[str | None, float | None]:
    candidates = [(r["engine"], _server_rankable(r, key)) for r in rows]
    candidates = [(name, value) for name, value in candidates if value is not None]
    if not candidates:
        return None, None
    return min(candidates, key=lambda pair: pair[1])


def _server_rank(rows: list[dict], engine: str, key: str) -> tuple[int, int]:
    scored = [(r["engine"], _server_rankable(r, key)) for r in rows]
    scored = [(name, value) for name, value in scored if value is not None]
    scored.sort(key=lambda pair: pair[1])
    names = [name for name, _ in scored]
    position = names.index(engine) + 1 if engine in names else 0
    return position, len(names)


def _cell(value: float | None, best: float | None, places: int) -> str:
    if value is None:
        return "n/a"
    marker = "*" if best is not None and abs(value - best) < 1e-9 else ""
    return f"{value:.{places}f}{marker}"


def _rank(rows: list[dict], engine: str, group: str, key: str, higher_is_better: bool) -> tuple[int, int]:
    scored = [(r["engine"], _value(r, group, key)) for r in rows]
    scored = [(name, value) for name, value in scored if value is not None]
    scored.sort(key=lambda pair: pair[1], reverse=higher_is_better)
    names = [name for name, _ in scored]
    position = names.index(engine) + 1 if engine in names else 0
    return position, len(names)


def _fmt_opt(value: float | None, places: int) -> str:
    return "n/a" if value is None else f"{value:.{places}f}"


def _quality_table(rows: list[dict]) -> list[str]:
    columns = [("ndcg_cut_10", "nDCG@10"), ("recall_100", "Recall@100"), ("map", "MAP"), ("recip_rank", "MRR")]
    bests = {key: _best(rows, "metrics", key, True)[1] for key, _ in columns}
    out = ["| Engine | " + " | ".join(label for _, label in columns) + " |"]
    out.append("|---|" + "|".join("---" for _ in columns) + "|")
    for row in rows:
        cells = [_cell(_value(row, "metrics", key), bests[key], 4) for key, _ in columns]
        out.append(f"| {row['engine']} | " + " | ".join(cells) + " |")
    return out


def _operational_table(rows: list[dict]) -> list[str]:
    columns = [
        ("operational", "ingest_docs_per_sec", "Ingest docs/s", 0, True),
        ("operational", "build_seconds", "Build s", 2, False),
        ("latency_server", "p50_ms", "Server p50 ms", 2, False),
        ("latency_server", "p95_ms", "Server p95 ms", 2, False),
        ("latency_server", "p99_ms", "Server p99 ms", 2, False),
    ]
    bests = {}
    for group, key, label, _, hib in columns:
        if group == "latency_server":
            bests[label] = _server_best(rows, key)[1]
        else:
            bests[label] = _best(rows, group, key, hib)[1]
    out = ["| Engine | " + " | ".join(label for _, _, label, _, _ in columns) + " |"]
    out.append("|---|" + "|".join("---" for _ in columns) + "|")
    for row in rows:
        cells = [_cell(_value(row, group, key), bests[label], places) for group, key, label, places, _ in columns]
        out.append(f"| {row['engine']} | " + " | ".join(cells) + " |")
    return out


def _client_latency_table(rows: list[dict]) -> list[str]:
    columns = [
        ("latency_client", "p50_ms", "Client p50 ms", 2),
        ("latency_client", "p95_ms", "Client p95 ms", 2),
        ("latency_client", "p99_ms", "Client p99 ms", 2),
    ]
    bests = {label: _best(rows, group, key, False)[1] for group, key, label, _ in columns}
    out = ["| Engine | " + " | ".join(label for _, _, label, _ in columns) + " |"]
    out.append("|---|" + "|".join("---" for _ in columns) + "|")
    for row in rows:
        cells = [_cell(_value(row, group, key), bests[label], places) for group, key, label, places in columns]
        out.append(f"| {row['engine']} | " + " | ".join(cells) + " |")
    return out


def _server_time_disclosure(rows: list[dict]) -> list[str]:
    out = ["Server-side time source per engine:", ""]
    for row in rows:
        out.append(f"- {row['engine']}: {row.get('server_time_disclosure', 'client round-trip only')}")
    return out


def _operating_table(rows: list[dict]) -> list[str]:
    out = [
        "| Engine | Knob | Value | ANN recall@k | Target met |",
        "|---|---|---|---|---|",
    ]
    for row in rows:
        point = row.get("operating_point") or {}
        out.append(
            "| {engine} | {knob} | {value} | {recall} | {met} |".format(
                engine=row["engine"],
                knob=point.get("knob", "n/a"),
                value=point.get("chosen_value", "n/a"),
                recall=_fmt_opt(point.get("achieved_recall"), 4),
                met="yes" if point.get("met_target") else "NO",
            )
        )
    return out


def _standing(rows: list[dict]) -> list[str]:
    ndcg_pos, ndcg_total = _rank(rows, "narsil", "metrics", "ndcg_cut_10", True)
    p50_pos, p50_total = _server_rank(rows, "narsil", "p50_ms")
    if not (ndcg_pos and p50_pos):
        return []
    ndcg_best_name, ndcg_best = _best(rows, "metrics", "ndcg_cut_10", True)
    p50_best_name, p50_best = _server_best(rows, "p50_ms")
    return [
        f"Narsil standing: nDCG@10 rank {ndcg_pos}/{ndcg_total} "
        f"(best {ndcg_best_name} {_fmt_opt(ndcg_best, 4)}); "
        f"server-side p50 latency rank {p50_pos}/{p50_total} "
        f"(fastest {p50_best_name} {_fmt_opt(p50_best, 2)} ms, among engines whose server-side timing "
        f"is above the measurement floor).",
        "",
    ]


def _build_cell(engine: dict) -> str:
    build = engine.get("build_identity") or {}
    commit = build.get("build_hash")
    if commit:
        return f"{commit[:12]}{' (dirty)' if build.get('dirty') else ''}"
    digest = engine.get("image_digest")
    if digest:
        return digest.split("@", 1)[-1][:19]
    return "n/a"


_TRACK_TITLES = {KEYWORD: "Keyword track", VECTOR: "Vector track", HYBRID: "Hybrid track"}


def render_comparison_markdown(comparison: dict) -> str:
    profile = comparison.get("profile", EQUAL_PRECISION)
    profile_title = _PROFILE_TITLES.get(profile, profile)
    lines: list[str] = [f"# Search-engine comparison ({profile_title}): keyword, vector, hybrid", ""]
    env = comparison["environment"]
    cfg = comparison["config"]
    cap = cfg.get("memory_cap_bytes")
    lines.append("## Run conditions")
    lines.append("")
    if profile == BEST_CONFIG:
        lines.append(
            "- Vector and hybrid tracks use each engine's own recommended production quantization (Narsil SQ8, "
            "Elasticsearch BBQ, OpenSearch SQfp16, Qdrant int8 scalar, Weaviate 8-bit RQ), every engine held to "
            "the same recall target via its own search-effort knob. Compression differs by engine by design."
        )
    else:
        lines.append("- Vector and hybrid tracks hold every engine at full float (no quantization) for an equal-precision comparison.")
    if env.get("machine_label"):
        lines.append(f"- Machine: {env.get('machine_label')}")
    lines.append(f"- OS / arch: {env.get('os')} / {env.get('arch')}")
    lines.append(f"- Equal memory cap per engine: {'n/a' if cap is None else f'{cap / 1e9:.1f} GB'}")
    lines.append(f"- Run depth: {cfg.get('run_depth')}; BM25 reference k1={cfg.get('k1')}, b={cfg.get('b')}")
    if cfg.get("vector_model"):
        lines.append(
            f"- Shared embedding model: {cfg.get('vector_model')} "
            f"({cfg.get('vector_dims')} dim, {cfg.get('vector_metric')}); "
            f"latency on the vector track is compared at matched ANN recall@{cfg.get('recall_k')} "
            f">= {cfg.get('recall_target')}."
        )
    lines.append("- Same datasets, metrics, run depth, and strictly-decreasing run-file ordering for every engine.")
    for dataset_id, identity in (comparison.get("dataset_identities") or {}).items():
        if identity.get("md5"):
            lines.append(f"- Dataset {dataset_id}: content md5 {identity['md5']} (ir_datasets-verified archive)")
    lines.append(
        "- Headline latency is each engine's own reported query time, captured from the same call the client "
        "round-trip is timed around. Resolution differs by engine and is disclosed per engine; an engine that "
        "reports no server-side time shows it as not-available and is compared on client round-trip only."
    )
    lines.append("")

    lines.append("## Engines and tracks")
    lines.append("")
    lines.append("| Engine | Version | Build | Tracks |")
    lines.append("|---|---|---|---|")
    for engine in comparison["engines"]:
        lines.append(
            f"| {engine['name']} | {engine.get('version') or 'n/a'} | {_build_cell(engine)} | "
            f"{', '.join(engine.get('tracks', []))} |"
        )
    lines.append("")

    for track in comparison["tracks"]:
        lines.append(f"# {_TRACK_TITLES.get(track['track'], track['track'])}")
        lines.append("")
        for dataset in track["datasets"]:
            rows = dataset["rows"]
            lines.append(f"## {dataset['dataset_id']}")
            lines.append("")
            lines.append("Retrieval quality, higher is better (* marks the best in each column):")
            lines.append("")
            lines.extend(_quality_table(rows))
            lines.append("")
            if track["track"] == VECTOR:
                lines.append("Matched-recall operating point per engine:")
                lines.append("")
                lines.extend(_operating_table(rows))
                lines.append("")
            lines.append(
                "Ingest and latency, latency lower is better (* marks the best in each column). "
                "The headline latency is each engine's own reported query time (server-side):"
            )
            lines.append("")
            lines.extend(_operational_table(rows))
            lines.append("")
            lines.append("Client round-trip latency, the same queries timed around the HTTP call:")
            lines.append("")
            lines.extend(_client_latency_table(rows))
            lines.append("")
            lines.extend(_server_time_disclosure(rows))
            throughput = throughput_lines(rows)
            if throughput:
                lines.append("")
                lines.extend(throughput)
            lines.append("")
            lines.extend(_standing(rows))
    return "\n".join(lines)
