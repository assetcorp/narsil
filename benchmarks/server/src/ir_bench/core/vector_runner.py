from __future__ import annotations

from pathlib import Path
from time import perf_counter

from . import datasets as ds
from .config import BenchmarkConfig, DatasetSpec, VectorConfig
from .embeddings import EmbeddingStore
from .latency import measure_latency
from .recall_tuning import TuningResult, tune_to_recall
from .runfile import run_mapping, strict_ranking, write_run_file
from .scoring import evaluate
from .throughput import measure_throughput
from .track_common import bulk_load_begin, bulk_load_end, best_effort, index_name, index_size_bytes, verify_indexed
from .types import BEST_CONFIG, EQUAL_PRECISION, HYBRID, SERVER_TIME_UNAVAILABLE, VECTOR, VectorDoc, VectorIndexParams


def _create_and_load(
    driver, config: BenchmarkConfig, spec: DatasetSpec, store: EmbeddingStore, profile: str
) -> tuple[str, int, float]:
    vec = config.vector
    assert vec is not None
    index = index_name(spec.dataset_id)
    params = VectorIndexParams(
        dims=vec.dims, metric=vec.metric, m=vec.hnsw_m, ef_construction=vec.hnsw_ef_construction, profile=profile
    )
    vector_by_id = store.vector_by_id(spec.dataset_id)

    def documents():
        for doc_id, text in ds.iter_documents(spec.dataset_id):
            yield VectorDoc(doc_id=doc_id, text=text, vector=vector_by_id[doc_id].tolist())

    driver.drop_index(index)
    driver.create_vector_index(index, params)
    bulk_load_begin(driver, index, spec)
    build_start = perf_counter()
    imported = driver.import_vectors(index, documents(), config.import_batch)
    driver.build_vectors(index)
    build_seconds = perf_counter() - build_start
    bulk_load_end(driver, index, spec)
    indexed = verify_indexed(driver, index, imported, spec.dataset_id)
    return index, indexed, build_seconds


def _operating_point(driver, vec: VectorConfig, tuning: TuningResult, oversample: float | None = None) -> dict:
    return {
        "knob": getattr(driver, "vector_knob", "efSearch"),
        "recall_metric": f"ann_recall@{vec.recall_k}",
        "recall_k": vec.recall_k,
        "target": tuning.target,
        "chosen_value": tuning.chosen_param,
        "rescore_oversample": oversample,
        "achieved_recall": tuning.achieved_recall,
        "met_target": tuning.met_target,
        "secondary_target": tuning.secondary_target,
        "secondary_value": tuning.secondary_param,
        "secondary_recall": tuning.secondary_recall,
        "sweep": [{"value": point.param, "recall": point.recall} for point in tuning.sweep],
    }


def _tune_rescore_oversample(
    driver, profile, tuning: TuningResult, index, query_vectors, query_ids, truth, vec: VectorConfig, dataset_id
) -> tuple[TuningResult, float | None]:
    """For a quantized best-config engine whose ef sweep plateaus below the recall
    target, escalate the full-precision rescore oversample, the knob that actually
    moves recall for rescore-based quantization. Picks the smallest oversample within
    the engine's valid range that clears the target; if none does, keeps the highest
    and reports the best achievable recall (met_target stays false)."""

    over_grid = getattr(driver, "rescore_oversample_grid", ())
    if profile != BEST_CONFIG or tuning.met_target or not hasattr(driver, "set_rescore_oversample") or not over_grid:
        return tuning, None

    best_ef = tuning.chosen_param
    print(
        f"[{driver.name}:{dataset_id}:vector:{profile}] ef plateaued at recall "
        f"{tuning.achieved_recall:.4f}; escalating rescore oversample",
        flush=True,
    )

    def run_at_oversample(oversample) -> dict[str, list[str]]:
        driver.set_rescore_oversample(float(oversample))
        approx: dict[str, list[str]] = {}
        for i, query_id in enumerate(query_ids):
            response = driver.vector_search(index, query_vectors[i], vec.recall_k, best_ef)
            approx[query_id] = [hit.doc_id for hit in response.hits[: vec.recall_k]]
        return approx

    over_tuning = tune_to_recall(
        run_at_oversample, over_grid, truth, vec.recall_k, vec.recall_target, vec.recall_target_secondary
    )
    chosen = float(over_tuning.chosen_param)
    driver.set_rescore_oversample(chosen)
    combined = TuningResult(
        chosen_param=best_ef,
        achieved_recall=over_tuning.achieved_recall,
        met_target=over_tuning.met_target,
        target=tuning.target,
        secondary_param=tuning.secondary_param,
        secondary_recall=tuning.secondary_recall,
        secondary_target=tuning.secondary_target,
        sweep=tuning.sweep,
    )
    return combined, chosen


def run_vector_track(
    driver,
    config: BenchmarkConfig,
    spec: DatasetSpec,
    runs_dir: Path,
    store: EmbeddingStore,
    run_tag: str,
    profile: str = EQUAL_PRECISION,
) -> dict:
    vec = config.vector
    assert vec is not None
    print(f"[{driver.name}:{spec.dataset_id}:vector:{profile}] loading judgements and vectors", flush=True)
    qrels = ds.load_qrels(spec.dataset_id)
    qset = store.queries(spec.dataset_id)
    query_vectors = [qset.vectors[i].tolist() for i in range(len(qset.ids))]

    print(f"[{driver.name}:{spec.dataset_id}:vector:{profile}] ingesting corpus", flush=True)
    index, indexed, build_seconds = _create_and_load(driver, config, spec, store, profile)
    ingest_rate = indexed / build_seconds if build_seconds > 0 else 0.0

    truth = store.truth(spec.dataset_id, vec.recall_k)

    def run_at(ef: int) -> dict[str, list[str]]:
        approx: dict[str, list[str]] = {}
        for i, query_id in enumerate(qset.ids):
            response = driver.vector_search(index, query_vectors[i], vec.recall_k, ef)
            approx[query_id] = [hit.doc_id for hit in response.hits[: vec.recall_k]]
        return approx

    if hasattr(driver, "set_rescore_oversample"):
        driver.set_rescore_oversample(None)
    grid = vec.ef_search_grid_best_config if profile == BEST_CONFIG else vec.ef_search_grid
    print(f"[{driver.name}:{spec.dataset_id}:vector:{profile}] tuning to recall@{vec.recall_k} >= {vec.recall_target}", flush=True)
    tuning = tune_to_recall(run_at, grid, truth, vec.recall_k, vec.recall_target, vec.recall_target_secondary)

    tuning, chosen_oversample = _tune_rescore_oversample(
        driver, profile, tuning, index, query_vectors, list(qset.ids), truth, vec, spec.dataset_id
    )

    quality_ef = max(tuning.chosen_param, config.run_depth)
    run: dict[str, list[tuple[str, float]]] = {}
    run_for_scoring: dict[str, dict[str, float]] = {}
    for i, query_id in enumerate(qset.ids):
        response = driver.vector_search(index, query_vectors[i], config.run_depth, quality_ef)
        ranked = strict_ranking(response.hits)
        run[query_id] = ranked
        run_for_scoring[query_id] = run_mapping(ranked)
    run_path = runs_dir / f"{index}.{run_tag}.run"
    write_run_file(run_path, run, run_tag)
    metrics = evaluate(qrels, run_for_scoring)

    print(f"[{driver.name}:{spec.dataset_id}:vector] measuring latency and throughput at the operating point", flush=True)
    server_time = getattr(driver, "server_time", SERVER_TIME_UNAVAILABLE)

    def vector_once(vector):
        return driver.vector_search(index, vector, config.latency.top_k, tuning.chosen_param)

    latency = measure_latency(vector_once, query_vectors, config.latency, server_time)
    throughput = measure_throughput(vector_once, query_vectors, config.throughput, server_time)

    stats = best_effort(lambda: driver.index_stats(index), "index stats")
    driver.drop_index(index)

    return {
        "dataset_id": spec.dataset_id,
        "dataset_identity": ds.dataset_content_id(spec.dataset_id),
        "track": VECTOR,
        "run_tag": run_tag,
        "vector_profile": profile,
        "setup": getattr(driver, "vector_setup", ""),
        "queries": len(qset.ids),
        "judged_queries": len(qrels),
        "metrics": metrics,
        "calibration": None,
        "operating_point": _operating_point(driver, vec, tuning, chosen_oversample),
        "vector_oversample": chosen_oversample,
        "operational": {
            "documents_indexed": indexed,
            "build_seconds": build_seconds,
            "ingest_docs_per_sec": ingest_rate,
            "index_size_bytes": index_size_bytes(stats),
            "raw_stats": stats,
        },
        "latency": latency,
        "throughput": throughput,
        "run_file": str(run_path),
    }


def run_hybrid_track(
    driver,
    config: BenchmarkConfig,
    spec: DatasetSpec,
    runs_dir: Path,
    store: EmbeddingStore,
    run_tag: str,
    vector_ef: int | None,
    profile: str = EQUAL_PRECISION,
    vector_oversample: float | None = None,
) -> dict:
    vec = config.vector
    assert vec is not None
    print(f"[{driver.name}:{spec.dataset_id}:hybrid:{profile}] loading queries, judgements, vectors", flush=True)
    terms = ds.load_queries(spec.dataset_id)
    qrels = ds.load_qrels(spec.dataset_id)
    qset = store.queries(spec.dataset_id)
    query_terms = {query_id: terms.get(query_id, "") for query_id in qset.ids}
    query_vectors = {query_id: qset.vectors[i].tolist() for i, query_id in enumerate(qset.ids)}

    print(f"[{driver.name}:{spec.dataset_id}:hybrid:{profile}] ingesting corpus", flush=True)
    index, indexed, build_seconds = _create_and_load(driver, config, spec, store, profile)
    ingest_rate = indexed / build_seconds if build_seconds > 0 else 0.0
    if hasattr(driver, "set_rescore_oversample"):
        driver.set_rescore_oversample(vector_oversample)

    grid = vec.ef_search_grid_best_config if profile == BEST_CONFIG else vec.ef_search_grid
    operating_ef = vector_ef if vector_ef is not None else grid[-1]
    quality_ef = max(operating_ef, config.run_depth)

    run: dict[str, list[tuple[str, float]]] = {}
    run_for_scoring: dict[str, dict[str, float]] = {}
    for query_id in qset.ids:
        response = driver.hybrid_search(index, query_terms[query_id], query_vectors[query_id], config.run_depth, quality_ef)
        ranked = strict_ranking(response.hits)
        run[query_id] = ranked
        run_for_scoring[query_id] = run_mapping(ranked)
    run_path = runs_dir / f"{index}.{run_tag}.run"
    write_run_file(run_path, run, run_tag)
    metrics = evaluate(qrels, run_for_scoring)

    print(f"[{driver.name}:{spec.dataset_id}:hybrid] measuring latency and throughput", flush=True)
    server_time = getattr(driver, "server_time", SERVER_TIME_UNAVAILABLE)
    query_ids = list(qset.ids)

    def hybrid_once(query_id):
        return driver.hybrid_search(
            index, query_terms[query_id], query_vectors[query_id], config.latency.top_k, operating_ef
        )

    latency = measure_latency(hybrid_once, query_ids, config.latency, server_time)
    throughput = measure_throughput(hybrid_once, query_ids, config.throughput, server_time)

    stats = best_effort(lambda: driver.index_stats(index), "index stats")
    driver.drop_index(index)

    return {
        "dataset_id": spec.dataset_id,
        "dataset_identity": ds.dataset_content_id(spec.dataset_id),
        "track": HYBRID,
        "run_tag": run_tag,
        "vector_profile": profile,
        "setup": getattr(driver, "hybrid_setup", ""),
        "queries": len(qset.ids),
        "judged_queries": len(qrels),
        "metrics": metrics,
        "calibration": None,
        "operating_point": {
            "fusion": getattr(driver, "hybrid_fusion", ""),
            "vector_knob": getattr(driver, "vector_knob", "efSearch"),
            "vector_value": operating_ef,
            "vector_ef_from_vector_track": vector_ef is not None,
            "rescore_oversample": vector_oversample,
        },
        "operational": {
            "documents_indexed": indexed,
            "build_seconds": build_seconds,
            "ingest_docs_per_sec": ingest_rate,
            "index_size_bytes": index_size_bytes(stats),
            "raw_stats": stats,
        },
        "latency": latency,
        "throughput": throughput,
        "run_file": str(run_path),
    }
