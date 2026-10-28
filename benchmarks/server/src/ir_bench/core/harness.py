from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

from . import datasets as ds
from .artifacts import dataset_slug
from .config import BenchmarkConfig, EngineConfig
from .config_datasets import DatasetSpec
from .embeddings import EmbeddingStore
from .keyword_relevance import load_keyword_index, score_keyword_queries
from .latency import measure_latency, warmup_sample
from .reporter import write_json
from .throughput import measure_throughput
from .throughput_process import CpuCounter
from .throughput_workload import Workload, request_caller
from .track_common import best_effort, index_size_bytes, server_setup
from .types import BEST_CONFIG, EQUAL_PRECISION, EngineError, HYBRID, KEYWORD, SERVER_TIME_UNAVAILABLE, VECTOR
from .vector_runner import run_hybrid_track, run_vector_track

CHECKPOINTS_DIRNAME = "tracks"


def checkpoint_path(checkpoint_dir: Path, track: str, dataset_id: str) -> Path:
    return checkpoint_dir / f"{track}.{dataset_slug(dataset_id)}.json"


def _load_checkpoint(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return loaded if isinstance(loaded, dict) else None


def _checkpointed(checkpoint_dir: Path | None, label: str, track: str, spec: DatasetSpec, run: Callable[[], dict]) -> dict:
    if checkpoint_dir is None:
        return run()
    path = checkpoint_path(checkpoint_dir, track, spec.dataset_id)
    loaded = _load_checkpoint(path)
    if loaded is not None:
        print(f"[{label}:{spec.dataset_id}:{track}] finished earlier under this run id; loaded {path}", flush=True)
        return loaded
    result = run()
    write_json(path, result)
    return result


def run_keyword_track(
    driver,
    engine_cfg: EngineConfig,
    config: BenchmarkConfig,
    spec: DatasetSpec,
    runs_dir: Path,
    engine_cpu: CpuCounter | None = None,
) -> dict:
    label = f"{driver.name}:{spec.dataset_id}:keyword"
    print(f"[{label}] loading queries and judgements", flush=True)
    queries = ds.load_queries(spec.dataset_id)
    qrels = ds.load_qrels(spec.dataset_id)

    loaded = load_keyword_index(driver, config, spec, label)
    index = loaded.name
    indexed = loaded.documents
    build_seconds = loaded.build_seconds
    ingest_rate = indexed / build_seconds if build_seconds > 0 else 0.0

    run_path = runs_dir / f"{index}.{driver.run_tag}.run"
    scores = score_keyword_queries(driver, index, queries, qrels, config.run_depth, run_path, label)
    metrics = scores.metrics
    run_file = scores.run_file

    print(f"[{driver.name}:{spec.dataset_id}:keyword] measuring query latency and throughput", flush=True)
    server_time = getattr(driver, "server_time", SERVER_TIME_UNAVAILABLE)
    query_list = list(queries.values())

    workload = Workload(
        engine=engine_cfg,
        bm25=config.bm25,
        track=KEYWORD,
        index=index,
        top_k=config.latency.top_k,
    )
    search_once = request_caller(driver, workload)

    warmup = [] if metrics is not None else warmup_sample(config.latency, query_list)
    latency = measure_latency(search_once, query_list, config.latency, server_time, warmup)
    throughput = measure_throughput(workload, query_list, config.throughput, server_time, engine_cpu)

    stats = best_effort(lambda: driver.index_stats(index), "index stats")
    setup_report = server_setup(driver)
    driver.drop_index(index)

    calibration = None
    if spec.baseline_ndcg10 is not None and metrics is not None:
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
        "dataset_identity": ds.dataset_content_id(spec.dataset_id),
        "track": KEYWORD,
        "run_tag": driver.run_tag,
        "setup": getattr(driver, "keyword_setup", ""),
        "server_setup": setup_report,
        "queries": len(queries),
        "judged_queries": len(qrels),
        "metrics": metrics,
        "calibration": calibration,
        "operating_point": None,
        "operational": {
            "documents_indexed": indexed,
            "build_seconds": build_seconds,
            "ingest_docs_per_sec": ingest_rate,
            "ingest_clients": config.import_clients,
            "ingest_batch_size": config.import_batch,
            "index_size_bytes": index_size_bytes(stats),
            "raw_stats": stats,
        },
        "latency": latency,
        "throughput": throughput,
        "run_file": run_file,
    }


def run_engine(
    driver,
    engine_cfg: EngineConfig,
    config: BenchmarkConfig,
    specs: tuple[DatasetSpec, ...],
    runs_dir: Path,
    store: EmbeddingStore | None,
    vector_profile: str = EQUAL_PRECISION,
    engine_cpu: CpuCounter | None = None,
    checkpoint_dir: Path | None = None,
) -> list[dict]:
    results: list[dict] = []
    driver.wait_until_ready()
    suffix = "_bestconfig" if vector_profile == BEST_CONFIG else ""
    label = engine_cfg.name
    for spec in specs:
        chosen_vector_ef: int | None = None
        chosen_vector_oversample: float | None = None
        for track in engine_cfg.tracks:
            if track == KEYWORD:
                if vector_profile == BEST_CONFIG:
                    continue
                results.append(
                    _checkpointed(
                        checkpoint_dir, label, KEYWORD, spec,
                        lambda: run_keyword_track(driver, engine_cfg, config, spec, runs_dir, engine_cpu),
                    )
                )
            elif track == VECTOR:
                if store is None or config.vector is None:
                    raise EngineError("vector track requires an embedding store and a [vector] config section")
                result = _checkpointed(
                    checkpoint_dir, label, VECTOR, spec,
                    lambda: run_vector_track(
                        driver, engine_cfg, config, spec, runs_dir, store,
                        f"{engine_cfg.name}_vector{suffix}", vector_profile, engine_cpu,
                    ),
                )
                point = result.get("operating_point")
                if point and point.get("chosen_value") is not None:
                    chosen_vector_ef = int(point["chosen_value"])
                chosen_vector_oversample = result.get("vector_oversample")
                results.append(result)
            elif track == HYBRID:
                if store is None or config.vector is None:
                    raise EngineError("hybrid track requires an embedding store and a [vector] config section")
                results.append(
                    _checkpointed(
                        checkpoint_dir, label, HYBRID, spec,
                        lambda: run_hybrid_track(
                            driver, engine_cfg, config, spec, runs_dir, store, f"{engine_cfg.name}_hybrid{suffix}",
                            chosen_vector_ef, vector_profile, chosen_vector_oversample, engine_cpu,
                        ),
                    )
                )
    return results
