from __future__ import annotations

import re
from pathlib import Path
from time import perf_counter

from . import datasets as ds
from .config import BenchmarkConfig, DatasetSpec
from .driver import EngineDriver
from .latency import measure_query_latency
from .runfile import run_mapping, strict_ranking, write_run_file
from .scoring import evaluate
from .types import EngineError


def index_name(dataset_id: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", dataset_id.lower()).strip("_")
    return f"bench_{slug}"


def _best_effort(action, label: str):
    try:
        return action()
    except EngineError as error:
        print(f"  warning: {label} unavailable: {error}", flush=True)
        return None


def _index_size_bytes(stats: dict | None) -> int | None:
    if not stats:
        return None
    value = stats.get("index_size_bytes")
    return int(value) if isinstance(value, (int, float)) else None


def run_one(driver: EngineDriver, config: BenchmarkConfig, spec: DatasetSpec, runs_dir: Path) -> dict:
    index = index_name(spec.dataset_id)
    print(f"[{driver.name}:{spec.dataset_id}] loading queries and judgements", flush=True)
    queries = ds.load_queries(spec.dataset_id)
    qrels = ds.load_qrels(spec.dataset_id)

    driver.drop_index(index)
    driver.create_index(index)

    print(f"[{driver.name}:{spec.dataset_id}] ingesting corpus", flush=True)
    build_start = perf_counter()
    imported = driver.import_documents(index, ds.iter_documents(spec.dataset_id), config.import_batch)
    build_seconds = perf_counter() - build_start

    if imported.indexed != imported.submitted:
        raise EngineError(
            f"{driver.name} indexed {imported.indexed} of {imported.submitted} submitted "
            f"documents for {spec.dataset_id}"
        )
    server_count = driver.count(index)
    if server_count != imported.indexed:
        raise EngineError(
            f"{driver.name} index reports {server_count} documents, expected {imported.indexed} "
            f"for {spec.dataset_id}"
        )
    indexed = imported.indexed
    ingest_rate = indexed / build_seconds if build_seconds > 0 else 0.0

    print(f"[{driver.name}:{spec.dataset_id}] running {len(queries)} queries at depth {config.run_depth}", flush=True)
    run: dict[str, list[tuple[str, float]]] = {}
    run_for_scoring: dict[str, dict[str, float]] = {}
    for query_id, term in queries.items():
        response = driver.search(index, term, config.run_depth)
        ranked = strict_ranking(response.hits)
        run[query_id] = ranked
        run_for_scoring[query_id] = run_mapping(ranked)

    run_path = runs_dir / f"{index}.{driver.run_tag}.run"
    write_run_file(run_path, run, driver.run_tag)

    metrics = evaluate(qrels, run_for_scoring)

    print(f"[{driver.name}:{spec.dataset_id}] measuring query latency", flush=True)
    latency = measure_query_latency(driver, index, list(queries.values()), config.latency)

    stats = _best_effort(lambda: driver.index_stats(index), "index stats")
    driver.drop_index(index)

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
            "index_size_bytes": _index_size_bytes(stats),
            "raw_stats": stats,
        },
        "latency": latency,
        "run_file": str(run_path),
    }


def run_engine(driver: EngineDriver, config: BenchmarkConfig, specs: tuple[DatasetSpec, ...], runs_dir: Path) -> list[dict]:
    results: list[dict] = []
    driver.wait_until_ready()
    for spec in specs:
        results.append(run_one(driver, config, spec, runs_dir))
    return results
