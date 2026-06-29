from __future__ import annotations

import json
from pathlib import Path


def build_report(environment: dict, config_summary: dict, datasets: list[dict]) -> dict:
    return {"environment": environment, "config": config_summary, "datasets": datasets}


def write_json(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=False), encoding="utf-8")


def _fmt(value: float | None, places: int = 4) -> str:
    return "n/a" if value is None else f"{value:.{places}f}"


def _calibration_label(calibration: dict | None) -> str:
    if not calibration or calibration.get("baseline_ndcg10") is None:
        return "no baseline"
    return "within margin" if calibration.get("within_margin") else "OUTSIDE margin"


def render_markdown(report: dict) -> str:
    lines: list[str] = ["# Narsil keyword retrieval benchmark", ""]

    env = report["environment"]
    lines.append("## Environment")
    lines.append("")
    lines.append(f"- Captured: {env.get('captured_at')}")
    if env.get("machine_label"):
        lines.append(f"- Machine: {env.get('machine_label')}")
    lines.append(f"- OS / arch: {env.get('os')} / {env.get('arch')} (containerized: {env.get('containerized')})")
    lines.append(f"- CPU: {env.get('cpu_model') or env.get('arch')} ({env.get('logical_cpus')} logical)")
    memory = env.get("total_memory_bytes")
    lines.append(f"- Memory: {'n/a' if memory is None else f'{memory / 1e9:.1f} GB'}")
    lines.append(f"- Python {env.get('python_version')}, ir_datasets {env.get('ir_datasets_version')}, pytrec_eval {env.get('pytrec_eval_version')}")
    cfg = report["config"]
    lines.append(f"- Narsil BM25: k1={cfg.get('k1')}, b={cfg.get('b')}; run depth {cfg.get('run_depth')}")
    lines.append("")

    lines.append("## Retrieval quality vs published baseline")
    lines.append("")
    lines.append("| Dataset | nDCG@10 | Baseline | Delta | Status | Recall@100 | MAP | MRR |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for dataset in report["datasets"]:
        metrics = dataset.get("metrics", {})
        calibration = dataset.get("calibration")
        baseline = None if calibration is None else calibration.get("baseline_ndcg10")
        delta = None if calibration is None else calibration.get("delta")
        lines.append(
            "| {id} | {ndcg} | {base} | {delta} | {status} | {recall} | {map_} | {mrr} |".format(
                id=dataset["dataset_id"],
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

    lines.append("## Operational metrics")
    lines.append("")
    lines.append("| Dataset | Docs | Ingest docs/s | Build s | Index mem | Snapshot | p50 ms | p95 ms | p99 ms |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for dataset in report["datasets"]:
        ops = dataset.get("operational", {})
        latency = dataset.get("latency", {})
        mem = ops.get("index_memory_bytes")
        snap = ops.get("snapshot_bytes")
        lines.append(
            "| {id} | {docs} | {rate} | {build} | {mem} | {snap} | {p50} | {p95} | {p99} |".format(
                id=dataset["dataset_id"],
                docs=ops.get("documents_indexed", "n/a"),
                rate=_fmt(ops.get("ingest_docs_per_sec"), 0),
                build=_fmt(ops.get("build_seconds"), 2),
                mem="n/a" if mem is None else f"{mem / 1e6:.1f} MB",
                snap="n/a" if snap is None else f"{snap / 1e6:.1f} MB",
                p50=_fmt(latency.get("p50_ms"), 2),
                p95=_fmt(latency.get("p95_ms"), 2),
                p99=_fmt(latency.get("p99_ms"), 2),
            )
        )
    lines.append("")
    return "\n".join(lines)
