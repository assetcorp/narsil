from __future__ import annotations

from .types import HYBRID, KEYWORD, TRACKS, VECTOR


def build_comparison(reports: list[dict]) -> dict:
    engines = [
        {
            "name": r["engine"]["name"],
            "version": r["engine"].get("version"),
            "tracks": r["engine"].get("tracks", []),
            "keyword_setup": r["engine"].get("keyword_setup"),
        }
        for r in reports
    ]

    buckets: dict[tuple[str, str], list[dict]] = {}
    track_datasets: dict[str, list[str]] = {track: [] for track in TRACKS}
    for report in reports:
        engine_name = report["engine"]["name"]
        for result in report["datasets"]:
            track = result.get("track", KEYWORD)
            dataset_id = result["dataset_id"]
            key = (track, dataset_id)
            if key not in buckets:
                buckets[key] = []
                if dataset_id not in track_datasets.setdefault(track, []):
                    track_datasets[track].append(dataset_id)
            buckets[key].append(
                {
                    "engine": engine_name,
                    "metrics": result.get("metrics", {}),
                    "latency": result.get("latency", {}),
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
        "engines": engines,
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
        ("latency", "p50_ms", "p50 ms", 2, False),
        ("latency", "p95_ms", "p95 ms", 2, False),
        ("latency", "p99_ms", "p99 ms", 2, False),
    ]
    bests = {label: _best(rows, group, key, hib)[1] for group, key, label, _, hib in columns}
    out = ["| Engine | " + " | ".join(label for _, _, label, _, _ in columns) + " |"]
    out.append("|---|" + "|".join("---" for _ in columns) + "|")
    for row in rows:
        cells = [_cell(_value(row, group, key), bests[label], places) for group, key, label, places, _ in columns]
        out.append(f"| {row['engine']} | " + " | ".join(cells) + " |")
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
    p50_pos, p50_total = _rank(rows, "narsil", "latency", "p50_ms", False)
    if not (ndcg_pos and p50_pos):
        return []
    ndcg_best_name, ndcg_best = _best(rows, "metrics", "ndcg_cut_10", True)
    p50_best_name, p50_best = _best(rows, "latency", "p50_ms", False)
    return [
        f"Narsil standing: nDCG@10 rank {ndcg_pos}/{ndcg_total} "
        f"(best {ndcg_best_name} {_fmt_opt(ndcg_best, 4)}); "
        f"p50 latency rank {p50_pos}/{p50_total} "
        f"(fastest {p50_best_name} {_fmt_opt(p50_best, 2)} ms).",
        "",
    ]


_TRACK_TITLES = {KEYWORD: "Keyword track", VECTOR: "Vector track", HYBRID: "Hybrid track"}


def render_comparison_markdown(comparison: dict) -> str:
    lines: list[str] = ["# Search-engine comparison: keyword, vector, hybrid", ""]
    env = comparison["environment"]
    cfg = comparison["config"]
    cap = cfg.get("memory_cap_bytes")
    lines.append("## Run conditions")
    lines.append("")
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
    lines.append("")

    lines.append("## Engines and tracks")
    lines.append("")
    lines.append("| Engine | Version | Tracks |")
    lines.append("|---|---|---|")
    for engine in comparison["engines"]:
        lines.append(
            f"| {engine['name']} | {engine.get('version') or 'n/a'} | {', '.join(engine.get('tracks', []))} |"
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
            lines.append("Ingest and latency, latency lower is better (* marks the best in each column):")
            lines.append("")
            lines.extend(_operational_table(rows))
            lines.append("")
            lines.extend(_standing(rows))
    return "\n".join(lines)
