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


def _and_join(names: list[str]) -> str:
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return ", ".join(names[:-1]) + ", and " + names[-1]


def _rank_info(pairs: list[tuple[str, float | None]], engine: str, places: int, higher_is_better: bool) -> dict | None:
    """Standard-competition rank of `engine` among the engines that report a value, judged
    at the precision the value is displayed so engines whose printed numbers match count as
    tied and share a rank. Reports the rank, how many engines are ranked, whether the engine
    sits in the top group, and that group's display value and members; None when the engine
    has no value."""

    scored = [(name, value) for name, value in pairs if value is not None]
    displayed = {name: f"{value:.{places}f}" for name, value in scored}
    if engine not in displayed:
        return None
    engine_value = float(displayed[engine])
    if higher_is_better:
        ahead = sum(1 for text in displayed.values() if float(text) > engine_value)
        top = max(displayed.values(), key=float)
    else:
        ahead = sum(1 for text in displayed.values() if float(text) < engine_value)
        top = min(displayed.values(), key=float)
    return {
        "rank": ahead + 1,
        "total": len(scored),
        "engine_display": displayed[engine],
        "top_display": top,
        "at_top": [name for name, text in displayed.items() if text == top],
        "engine_at_top": displayed[engine] == top,
    }


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


def _server_best_mark(rows: list[dict], key: str, places: int) -> float | None:
    """The server-side latency to mark as fastest, or None when the column cannot be
    ranked honestly. If any engine reports a time below its resolution floor, its true
    latency is hidden below what its timer resolves, so no engine is crowned; the
    per-engine standing still states narsil's rank among engines above the floor."""

    rankable: list[float | None] = []
    for row in rows:
        if _value(row, "latency_server", key) is None:
            continue
        eligible = _server_rankable(row, key)
        if eligible is None:
            return None
        rankable.append(eligible)
    return _distinct_best(rankable, False, places)


def _server_cell(row: dict, key: str, best: float | None, places: int) -> str:
    value = _value(row, "latency_server", key)
    if value is None:
        return "n/a"
    if row.get("server_time_resolution") == INTEGER_MS and value < _INTEGER_MS_FLOOR_MS:
        return "&lt;1"
    marker = "\\*" if best is not None and f"{value:.{places}f}" == f"{best:.{places}f}" else ""
    return f"{value:.{places}f}{marker}"


def _cell(value: float | None, best: float | None, places: int) -> str:
    if value is None:
        return "n/a"
    marker = "\\*" if best is not None and f"{value:.{places}f}" == f"{best:.{places}f}" else ""
    return f"{value:.{places}f}{marker}"


def _fmt_opt(value: float | None, places: int) -> str:
    return "n/a" if value is None else f"{value:.{places}f}"


def _head(labels: list[str]) -> list[str]:
    """A table's header row and its delimiter row, built from one label list so the
    delimiter always has exactly one column per header cell; a mismatch stops the block
    rendering as a table at all."""

    return ["| " + " | ".join(labels) + " |", "| " + " | ".join("---" for _ in labels) + " |"]


def _distinct_best(values: list[float | None], higher_is_better: bool, places: int) -> float | None:
    """The value to mark as best, or None when there is no distinct winner. Distinctness
    is judged at the precision each cell displays, so engines that render the same number
    are treated as tied: they either share the marker or, when every engine shows the same
    value (as on the vector track at matched recall), none is marked, since a marker on
    every cell highlights nothing."""

    present = [value for value in values if value is not None]
    if len(present) < 2 or len({f"{value:.{places}f}" for value in present}) < 2:
        return None
    return max(present) if higher_is_better else min(present)


def _quality_table(rows: list[dict]) -> list[str]:
    columns = [("ndcg_cut_10", "nDCG@10"), ("recall_100", "Recall@100"), ("map", "MAP"), ("recip_rank", "MRR")]
    bests = {key: _distinct_best([_value(r, "metrics", key) for r in rows], True, 4) for key, _ in columns}
    out = _head(["Engine"] + [label for _, label in columns])
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
    for group, key, label, places, hib in columns:
        if group == "latency_server":
            bests[label] = _server_best_mark(rows, key, places)
        else:
            bests[label] = _distinct_best([_value(r, group, key) for r in rows], hib, places)
    out = _head(["Engine"] + [label for _, _, label, _, _ in columns])
    for row in rows:
        cells = []
        for group, key, label, places, _ in columns:
            if group == "latency_server":
                cells.append(_server_cell(row, key, bests[label], places))
            else:
                cells.append(_cell(_value(row, group, key), bests[label], places))
        out.append(f"| {row['engine']} | " + " | ".join(cells) + " |")
    return out


def _client_latency_table(rows: list[dict]) -> list[str]:
    columns = [
        ("latency_client", "p50_ms", "Client p50 ms", 2),
        ("latency_client", "p95_ms", "Client p95 ms", 2),
        ("latency_client", "p99_ms", "Client p99 ms", 2),
    ]
    bests = {label: _distinct_best([_value(r, group, key) for r in rows], False, places) for group, key, label, places in columns}
    out = _head(["Engine"] + [label for _, _, label, _ in columns])
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
        "| --- | --- | --- | --- | --- |",
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


def _ndcg_clause(info: dict) -> str:
    if info["engine_at_top"]:
        if len(info["at_top"]) == 1:
            return f"has the best nDCG@10 at {info['engine_display']}"
        return f"ties for the best nDCG@10 ({len(info['at_top'])}-way tie at {info['engine_display']})"
    leaders = info["at_top"]
    label = "tied best" if len(leaders) > 1 else "best"
    return f"ranks {info['rank']}/{info['total']} on nDCG@10 ({label}: {_and_join(leaders)}, {info['top_display']})"


def _p50_clause(info: dict) -> str:
    floor = "among engines above the measurement floor"
    if info["engine_at_top"]:
        if len(info["at_top"]) == 1:
            return f"has the fastest server-side p50 latency at {info['engine_display']} ms ({floor})"
        return (
            f"ties for the fastest server-side p50 latency "
            f"({len(info['at_top'])}-way tie at {info['engine_display']} ms, {floor})"
        )
    leaders = info["at_top"]
    label = "tied fastest" if len(leaders) > 1 else "fastest"
    return (
        f"ranks {info['rank']}/{info['total']} on server-side p50 latency "
        f"({label}: {_and_join(leaders)}, {info['top_display']} ms, {floor})"
    )


def _standing(rows: list[dict]) -> list[str]:
    ndcg = _rank_info([(row["engine"], _value(row, "metrics", "ndcg_cut_10")) for row in rows], "narsil", 4, True)
    p50 = _rank_info([(row["engine"], _server_rankable(row, "p50_ms")) for row in rows], "narsil", 2, False)
    if not (ndcg and p50):
        return []
    return [f"Narsil {_ndcg_clause(ndcg)} and {_p50_clause(p50)}.", ""]


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
            "Elasticsearch BBQ, OpenSearch SQfp16, Qdrant int8 scalar, Weaviate 8-bit RQ). Every engine meets the "
            "same recall target through its own search-effort knob, so compression differs by engine by design."
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
    lines.append("- Every engine uses the same datasets, metrics, run depth, and strictly-decreasing run-file ordering.")
    for dataset_id, identity in (comparison.get("dataset_identities") or {}).items():
        if identity.get("md5"):
            lines.append(f"- Dataset {dataset_id}: content md5 {identity['md5']} (ir_datasets-verified archive)")
    lines.append(
        "- Headline latency is each engine's own reported query time, read from the same response the client "
        "round-trip wraps. Resolution differs by engine and is disclosed below; an engine that exposes no "
        "server-side time is marked not-available and compared on client round-trip only."
    )
    lines.append("")

    lines.append("## Engines and tracks")
    lines.append("")
    lines.append("| Engine | Version | Build | Tracks |")
    lines.append("| --- | --- | --- | --- |")
    for engine in comparison["engines"]:
        lines.append(
            f"| {engine['name']} | {engine.get('version') or 'n/a'} | {_build_cell(engine)} | "
            f"{', '.join(engine.get('tracks', []))} |"
        )
    lines.append("")

    for track in comparison["tracks"]:
        lines.append(f"## {_TRACK_TITLES.get(track['track'], track['track'])}")
        lines.append("")
        for dataset in track["datasets"]:
            rows = dataset["rows"]
            lines.append(f"### {dataset['dataset_id']}")
            lines.append("")
            lines.append("Retrieval quality (higher is better). A star marks the best in each column:")
            lines.append("")
            lines.extend(_quality_table(rows))
            lines.append("")
            if track["track"] == VECTOR:
                lines.append("Matched-recall operating point per engine:")
                lines.append("")
                lines.extend(_operating_table(rows))
                lines.append("")
            lines.append(
                "Ingest throughput (higher is better) and query latency (lower is better). The headline latency "
                "is each engine's own server-side query time; a star marks the best in each column:"
            )
            lines.append("")
            lines.extend(_operational_table(rows))
            lines.append("")
            lines.append("Client round-trip latency for the same queries, timed around the HTTP call:")
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
