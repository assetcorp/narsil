from __future__ import annotations

import json
from pathlib import Path

from .latency_report import client_summary, disclosure, server_summary
from .throughput_report import per_engine_lines
from .types import EQUAL_PRECISION, HYBRID, KEYWORD, VECTOR


def build_engine_report(environment: dict, engine: dict, config_summary: dict, datasets: list[dict]) -> dict:
    return {"environment": environment, "engine": engine, "config": config_summary, "datasets": datasets}


def write_json(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=False), encoding="utf-8")


def _fmt(value: float | None, places: int = 4) -> str:
    return "n/a" if value is None else f"{value:.{places}f}"


def _by_track(results: list[dict], track: str) -> list[dict]:
    return [result for result in results if result.get("track") == track]


def _calibration_label(calibration: dict | None) -> str:
    if not calibration or calibration.get("baseline_ndcg10") is None:
        return "no baseline"
    return "within margin" if calibration.get("within_margin") else "outside margin"


def _quality_columns(rows: list[dict]) -> list[str]:
    lines = ["| Dataset | nDCG@10 | Recall@100 | MAP | MRR |", "|---|---|---|---|---|"]
    for row in rows:
        metrics = row.get("metrics", {})
        lines.append(
            f"| {row['dataset_id']} | {_fmt(metrics.get('ndcg_cut_10'))} | {_fmt(metrics.get('recall_100'))} | "
            f"{_fmt(metrics.get('map'))} | {_fmt(metrics.get('recip_rank'))} |"
        )
    return lines


def _operational_columns(rows: list[dict]) -> list[str]:
    lines = [
        "Operational metrics. Latency below is the engine's own reported query time "
        "(server-side); the client round-trip is reported separately underneath.",
        "",
        "| Dataset | Docs | Ingest docs/s | Build s | Index size | Server p50 ms | Server p95 ms | Server p99 ms |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        ops = row.get("operational", {})
        server = server_summary(row.get("latency", {}))
        size = ops.get("index_size_bytes")
        lines.append(
            "| {id} | {docs} | {rate} | {build} | {size} | {p50} | {p95} | {p99} |".format(
                id=row["dataset_id"],
                docs=ops.get("documents_indexed", "n/a"),
                rate=_fmt(ops.get("ingest_docs_per_sec"), 0),
                build=_fmt(ops.get("build_seconds"), 2),
                size="n/a" if size is None else f"{size / 1e6:.1f} MB",
                p50="n/a" if server is None else _fmt(server.get("p50_ms"), 2),
                p95="n/a" if server is None else _fmt(server.get("p95_ms"), 2),
                p99="n/a" if server is None else _fmt(server.get("p99_ms"), 2),
            )
        )
    lines.append("")
    lines.extend(_client_latency_columns(rows))
    lines.append("")
    lines.extend(_server_time_disclosure(rows))
    for row in rows:
        throughput = per_engine_lines(row)
        if throughput:
            lines.append("")
            lines.append(f"{row['dataset_id']} throughput:")
            lines.append("")
            lines.extend(throughput)
    return lines


def _client_latency_columns(rows: list[dict]) -> list[str]:
    lines = [
        "Client round-trip latency (wall-clock around the HTTP call, includes "
        "transport and JSON), measured over the same queries and repeats:",
        "",
        "| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |",
        "|---|---|---|---|",
    ]
    for row in rows:
        client = client_summary(row.get("latency", {}))
        lines.append(
            "| {id} | {p50} | {p95} | {p99} |".format(
                id=row["dataset_id"],
                p50=_fmt(client.get("p50_ms"), 2),
                p95=_fmt(client.get("p95_ms"), 2),
                p99=_fmt(client.get("p99_ms"), 2),
            )
        )
    return lines


def _server_time_disclosure(rows: list[dict]) -> list[str]:
    lines = ["Server-side time source per dataset:", ""]
    for row in rows:
        lines.append(f"- {row['dataset_id']}: {disclosure(row.get('latency', {}))}")
    return lines


def _keyword_section(rows: list[dict]) -> list[str]:
    lines = ["## Keyword track", "", "Retrieval quality vs Anserini BM25 reference:", ""]
    lines.append("| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for row in rows:
        metrics = row.get("metrics", {})
        calibration = row.get("calibration")
        baseline = None if calibration is None else calibration.get("baseline_ndcg10")
        delta = None if calibration is None else calibration.get("delta")
        lines.append(
            "| {id} | {ndcg} | {base} | {delta} | {status} | {recall} | {map_} | {mrr} |".format(
                id=row["dataset_id"],
                ndcg=_fmt(metrics.get("ndcg_cut_10")),
                base=_fmt(baseline),
                delta="n/a" if delta is None else f"{delta:+.4f}",
                status=_calibration_label(calibration),
                recall=_fmt(metrics.get("recall_100")),
                map_=_fmt(metrics.get("map")),
                mrr=_fmt(metrics.get("recip_rank")),
            )
        )
    lines.append("")
    lines.extend(_operational_columns(rows))
    lines.append("")
    return lines


def _operating_point_lines(rows: list[dict]) -> list[str]:
    lines = [
        "Recall operating point (latency below is measured here, the matched-recall rule for ANN search):",
        "",
        "| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |",
        "|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        point = row.get("operating_point") or {}
        lines.append(
            "| {id} | {knob} | {value} | {recall} | {met} | {sval} | {srecall} |".format(
                id=row["dataset_id"],
                knob=point.get("knob", "n/a"),
                value=point.get("chosen_value", "n/a"),
                recall=_fmt(point.get("achieved_recall")),
                met="yes" if point.get("met_target") else "NO",
                sval=point.get("secondary_value") if point.get("secondary_value") is not None else "n/a",
                srecall=_fmt(point.get("secondary_recall")) if point.get("secondary_recall") is not None else "n/a",
            )
        )
    lines.append("")
    return lines


def _vector_section(rows: list[dict], config: dict) -> list[str]:
    setup = rows[0].get("setup", "") if rows else ""
    target = config.get("recall_target")
    recall_k = config.get("recall_k")
    lines = [
        "## Vector track",
        "",
        f"- Embedding model: {config.get('vector_model')} ({config.get('vector_dims')} dim, {config.get('vector_metric')})",
        f"- Index setup: {setup}",
        f"- Operating point: search knob tuned to ann_recall@{recall_k} >= {target} against exact kNN over the same vectors",
        "",
        "Retrieval quality vs human judgements:",
        "",
    ]
    lines.extend(_quality_columns(rows))
    lines.append("")
    lines.extend(_operating_point_lines(rows))
    lines.append("Latency is measured at the operating point.")
    lines.append("")
    lines.extend(_operational_columns(rows))
    lines.append("")
    return lines


def _hybrid_section(rows: list[dict]) -> list[str]:
    setup = rows[0].get("setup", "") if rows else ""
    fusion = (rows[0].get("operating_point") or {}).get("fusion", "") if rows else ""
    lines = [
        "## Hybrid track",
        "",
        f"- Setup: {setup}",
        f"- Fusion: {fusion}",
        "",
        "Retrieval quality vs human judgements:",
        "",
    ]
    lines.extend(_quality_columns(rows))
    lines.append("")
    lines.extend(_operational_columns(rows))
    lines.append("")
    return lines


def _environment_lines(report: dict) -> list[str]:
    env = report["environment"]
    cfg = report["config"]
    engine = report["engine"]
    cap = cfg.get("memory_cap_bytes")
    memory = env.get("total_memory_bytes")
    tracks = ", ".join(engine.get("tracks", []))
    lines = ["## Environment", ""]
    lines.append(f"- Captured: {env.get('captured_at')}")
    if env.get("machine_label"):
        lines.append(f"- Machine: {env.get('machine_label')}")
    lines.append(f"- OS / arch: {env.get('os')} / {env.get('arch')} (containerized: {env.get('containerized')})")
    lines.append(f"- CPU: {env.get('cpu_model') or env.get('arch')} ({env.get('logical_cpus')} logical)")
    lines.append(f"- Memory: {'n/a' if memory is None else f'{memory / 1e9:.1f} GB'}")
    lines.append(f"- Memory cap per engine: {'n/a' if cap is None else f'{cap / 1e9:.1f} GB'}")
    lines.append(f"- Tracks: {tracks}")
    lines.append(f"- Keyword setup: {engine.get('keyword_setup')}")
    lines.append(f"- Run depth: {cfg.get('run_depth')}; run tag: {engine.get('run_tag')}")
    lines.extend(_provenance_lines(report))
    lines.append("")
    return lines


def _engine_build_line(engine: dict) -> str:
    build = engine.get("build_identity") or {}
    version = build.get("version") or engine.get("version") or "n/a"
    commit = build.get("build_hash")
    suffix = ""
    if commit:
        suffix = f", commit {commit[:12]}"
        if build.get("dirty"):
            suffix += " (dirty tree)"
    return f"- Engine build: version {version}{suffix}"


def _provenance_lines(report: dict) -> list[str]:
    """Provenance of the exact code and data under test: the engine's own build
    identity, the immutable image artifact it ran as, and the content hash of each
    dataset, so a result can be tied to a precise engine build and corpus version."""

    engine = report["engine"]
    lines = [_engine_build_line(engine)]
    digest = engine.get("image_digest")
    if digest:
        lines.append(f"- Engine image: {digest}")
    seen: dict[str, str] = {}
    for result in report["datasets"]:
        identity = result.get("dataset_identity") or {}
        md5 = identity.get("md5")
        if md5 and result["dataset_id"] not in seen:
            seen[result["dataset_id"]] = md5
    for dataset_id, md5 in seen.items():
        lines.append(f"- Dataset {dataset_id}: content md5 {md5}")
    return lines


def render_engine_markdown(report: dict) -> str:
    engine = report["engine"]
    config = report["config"]
    results = report["datasets"]
    tracks = ", ".join(engine.get("tracks", []))
    profile = engine.get("vector_profile", EQUAL_PRECISION)
    profile_note = "" if profile == EQUAL_PRECISION else f", {profile} vector profile"
    lines: list[str] = [f"# {engine['name']} retrieval ({tracks}{profile_note})", ""]
    lines.extend(_environment_lines(report))

    keyword_rows = _by_track(results, KEYWORD)
    if keyword_rows:
        lines.extend(_keyword_section(keyword_rows))
    vector_rows = _by_track(results, VECTOR)
    if vector_rows:
        lines.extend(_vector_section(vector_rows, config))
    hybrid_rows = _by_track(results, HYBRID)
    if hybrid_rows:
        lines.extend(_hybrid_section(hybrid_rows))
    return "\n".join(lines)
