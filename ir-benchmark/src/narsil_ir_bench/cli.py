from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter

from . import datasets as ds
from .client import NarsilClient, NarsilError
from .config import BenchmarkConfig, DatasetSpec, load_config
from .environment import capture_environment
from .latency import measure_query_latency
from .reporter import build_report, render_markdown, write_json
from .runfile import run_mapping, strict_ranking, write_run_file
from .scoring import evaluate

_MEMORY_KEYS = ("estimatedMemoryBytes", "memoryBytes", "memoryEstimateBytes", "memory", "bytes")


def _index_name(dataset_id: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", dataset_id.lower()).strip("_")
    return f"bench_{slug}"


def _extract_memory(stats: dict | None) -> int | None:
    if not stats:
        return None
    for key in _MEMORY_KEYS:
        value = stats.get(key)
        if isinstance(value, (int, float)):
            return int(value)
    return None


def _best_effort(action, label: str):
    try:
        return action()
    except NarsilError as error:
        print(f"  warning: {label} unavailable: {error}", flush=True)
        return None


def _run_one(client: NarsilClient, config: BenchmarkConfig, spec: DatasetSpec, runs_dir: Path) -> dict:
    index = _index_name(spec.dataset_id)
    print(f"[{spec.dataset_id}] loading queries and judgements", flush=True)
    queries = ds.load_queries(spec.dataset_id)
    qrels = ds.load_qrels(spec.dataset_id)

    client.drop_index_if_exists(index)
    client.create_index(index, k1=config.bm25.k1, b=config.bm25.b, language=config.language)

    print(f"[{spec.dataset_id}] ingesting corpus", flush=True)
    build_start = perf_counter()
    imported = client.import_documents(index, ds.iter_documents(spec.dataset_id), config.import_batch)
    build_seconds = perf_counter() - build_start

    if imported.indexed != imported.submitted:
        raise NarsilError(
            f"server accepted {imported.indexed} of {imported.submitted} submitted documents for {spec.dataset_id}"
        )
    server_count = client.count(index)
    if server_count != imported.indexed:
        raise NarsilError(
            f"index reports {server_count} documents, expected {imported.indexed} for {spec.dataset_id}"
        )
    indexed = imported.indexed
    ingest_rate = indexed / build_seconds if build_seconds > 0 else 0.0

    print(f"[{spec.dataset_id}] running {len(queries)} queries at depth {config.run_depth}", flush=True)
    run: dict[str, list[tuple[str, float]]] = {}
    run_for_scoring: dict[str, dict[str, float]] = {}
    for query_id, term in queries.items():
        response = client.search(index, term, config.run_depth)
        ranked = strict_ranking(response.hits)
        run[query_id] = ranked
        run_for_scoring[query_id] = run_mapping(ranked)

    run_path = runs_dir / f"{index}.{config.run_tag}.run"
    write_run_file(run_path, run, config.run_tag)

    metrics = evaluate(qrels, run_for_scoring)

    print(f"[{spec.dataset_id}] measuring query latency", flush=True)
    latency = measure_query_latency(client, index, list(queries.values()), config.latency)

    stats = _best_effort(lambda: client.stats(index), "index stats")
    snapshot_bytes = _best_effort(lambda: client.snapshot_bytes(index), "snapshot size")
    client.drop_index_if_exists(index)

    calibration = None
    if spec.baseline_ndcg10 is not None:
        delta = metrics["ndcg_cut_10"] - spec.baseline_ndcg10
        calibration = {
            "baseline_ndcg10": spec.baseline_ndcg10,
            "baseline_source": spec.baseline_source,
            "margin": spec.margin,
            "delta": delta,
            "within_margin": abs(delta) <= spec.margin,
        }

    return {
        "dataset_id": spec.dataset_id,
        "queries": len(queries),
        "judged_queries": len(qrels),
        "metrics": metrics,
        "calibration": calibration,
        "operational": {
            "documents_indexed": indexed,
            "build_seconds": build_seconds,
            "ingest_docs_per_sec": ingest_rate,
            "index_memory_bytes": _extract_memory(stats),
            "snapshot_bytes": snapshot_bytes,
            "raw_stats": stats,
        },
        "latency": latency,
        "run_file": str(run_path),
    }


def _select(config: BenchmarkConfig, only: str | None) -> tuple[DatasetSpec, ...]:
    if not only:
        return config.datasets
    wanted = {name.strip() for name in only.split(",") if name.strip()}
    selected = tuple(spec for spec in config.datasets if spec.dataset_id in wanted)
    if not selected:
        raise SystemExit(f"no configured datasets matched: {sorted(wanted)}")
    return selected


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Drive Narsil over HTTP and score keyword retrieval quality.")
    parser.add_argument("--config", type=Path, default=Path("config/benchmark.toml"))
    parser.add_argument("--server-url", default=None)
    parser.add_argument("--results-dir", type=Path, default=Path("results"))
    parser.add_argument("--runs-dir", type=Path, default=Path("runs"))
    parser.add_argument("--datasets", default=None, help="comma-separated subset of configured dataset ids")
    args = parser.parse_args(argv)

    config = load_config(args.config, server_url_override=args.server_url)
    specs = _select(config, args.datasets)

    environment = capture_environment()
    config_summary = {
        "server_url": config.server_url,
        "k1": config.bm25.k1,
        "b": config.bm25.b,
        "run_depth": config.run_depth,
        "run_tag": config.run_tag,
        "language": config.language,
    }

    results: list[dict] = []
    with NarsilClient(config.server_url) as client:
        print(f"waiting for Narsil at {config.server_url}", flush=True)
        client.wait_until_ready()
        for spec in specs:
            results.append(_run_one(client, config, spec, args.runs_dir))

    report = build_report(environment, config_summary, results)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    write_json(args.results_dir / f"{stamp}.json", report)
    markdown = render_markdown(report)
    (args.results_dir / f"{stamp}.md").write_text(markdown, encoding="utf-8")
    print("\n" + markdown, flush=True)

    outside = [
        r["dataset_id"]
        for r in results
        if r.get("calibration") and not r["calibration"]["within_margin"]
    ]
    if outside:
        print(f"\nCalibration check: {len(outside)} dataset(s) outside margin: {', '.join(outside)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
