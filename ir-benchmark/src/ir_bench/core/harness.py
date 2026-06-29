from __future__ import annotations

from pathlib import Path
from time import perf_counter

from . import datasets as ds
from .config import BenchmarkConfig, DatasetSpec, EngineConfig
from .embeddings import EmbeddingStore
from .latency import measure_query_latency
from .runfile import run_mapping, strict_ranking, write_run_file
from .scoring import evaluate
from .track_common import best_effort, index_name, index_size_bytes, verify_indexed
from .types import EngineError, HYBRID, KEYWORD, VECTOR
from .vector_runner import run_hybrid_track, run_vector_track


def run_keyword_track(driver, config: BenchmarkConfig, spec: DatasetSpec, runs_dir: Path) -> dict:
    index = index_name(spec.dataset_id)
    print(f"[{driver.name}:{spec.dataset_id}:keyword] loading queries and judgements", flush=True)
    queries = ds.load_queries(spec.dataset_id)
    qrels = ds.load_qrels(spec.dataset_id)

    driver.drop_index(index)
    driver.create_index(index)

    print(f"[{driver.name}:{spec.dataset_id}:keyword] ingesting corpus", flush=True)
    build_start = perf_counter()
    imported = driver.import_documents(index, ds.iter_documents(spec.dataset_id), config.import_batch)
    build_seconds = perf_counter() - build_start
    indexed = verify_indexed(driver, index, imported, spec.dataset_id)
    ingest_rate = indexed / build_seconds if build_seconds > 0 else 0.0

    print(f"[{driver.name}:{spec.dataset_id}:keyword] running {len(queries)} queries", flush=True)
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

    print(f"[{driver.name}:{spec.dataset_id}:keyword] measuring query latency", flush=True)
    latency = measure_query_latency(driver, index, list(queries.values()), config.latency)

    stats = best_effort(lambda: driver.index_stats(index), "index stats")
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
        "track": KEYWORD,
        "run_tag": driver.run_tag,
        "setup": getattr(driver, "keyword_setup", ""),
        "queries": len(queries),
        "judged_queries": len(qrels),
        "metrics": metrics,
        "calibration": calibration,
        "operating_point": None,
        "operational": {
            "documents_indexed": indexed,
            "build_seconds": build_seconds,
            "ingest_docs_per_sec": ingest_rate,
            "index_size_bytes": index_size_bytes(stats),
            "raw_stats": stats,
        },
        "latency": latency,
        "run_file": str(run_path),
    }


def run_engine(
    driver,
    engine_cfg: EngineConfig,
    config: BenchmarkConfig,
    specs: tuple[DatasetSpec, ...],
    runs_dir: Path,
    store: EmbeddingStore | None,
) -> list[dict]:
    results: list[dict] = []
    driver.wait_until_ready()
    for spec in specs:
        chosen_vector_ef: int | None = None
        for track in engine_cfg.tracks:
            if track == KEYWORD:
                results.append(run_keyword_track(driver, config, spec, runs_dir))
            elif track == VECTOR:
                if store is None or config.vector is None:
                    raise EngineError("vector track requires an embedding store and a [vector] config section")
                result = run_vector_track(driver, config, spec, runs_dir, store, f"{engine_cfg.name}_vector")
                point = result.get("operating_point")
                if point and point.get("chosen_value") is not None:
                    chosen_vector_ef = int(point["chosen_value"])
                results.append(result)
            elif track == HYBRID:
                if store is None or config.vector is None:
                    raise EngineError("hybrid track requires an embedding store and a [vector] config section")
                results.append(
                    run_hybrid_track(
                        driver, config, spec, runs_dir, store, f"{engine_cfg.name}_hybrid", chosen_vector_ef
                    )
                )
    return results
