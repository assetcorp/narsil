from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from time import perf_counter

from . import datasets as ds
from .config import BenchmarkConfig, EngineConfig, VectorConfig
from .config_datasets import DatasetSpec
from .embeddings import EmbeddingStore
from .latency import Trip, measure_latency, timed_trip, warmup_sample
from .recall_sweep import sweep_throughput
from .runfile import run_mapping, strict_ranking, write_run_file
from .scoring import evaluate
from .throughput import measure_throughput
from .throughput_process import CpuCounter
from .throughput_workload import Workload, request_caller
from .track_common import (
    best_effort,
    bulk_load_begin,
    bulk_load_end,
    index_name,
    index_size_bytes,
    server_setup,
    verify_indexed,
)
from .types import BEST_CONFIG, EQUAL_PRECISION, HYBRID, SERVER_TIME_UNAVAILABLE, VECTOR, VectorDoc, VectorIndexParams
from .vector_tuning import OperatingPoint, sample_indices, tune_operating_point


def _create_and_load(
    driver, config: BenchmarkConfig, spec: DatasetSpec, store: EmbeddingStore, profile: str
) -> tuple[str, int, float]:
    vec = config.vector
    assert vec is not None
    index = index_name(spec.dataset_id)
    params = VectorIndexParams(
        dims=store.dims_for(spec.dataset_id),
        metric=vec.metric,
        m=vec.hnsw_m,
        ef_construction=vec.hnsw_ef_construction,
        profile=profile,
    )
    vector_by_id = store.vector_by_id(spec.dataset_id)

    def documents():
        for doc_id, text in ds.iter_documents(spec.dataset_id):
            yield VectorDoc(doc_id=doc_id, text=text, vector=vector_by_id[doc_id])

    driver.drop_index(index)
    driver.create_vector_index(index, params)
    bulk_load_begin(driver, index, spec)
    build_start = perf_counter()
    imported = driver.import_vectors(index, documents(), config.import_batch, config.import_clients)
    driver.build_vectors(index)
    build_seconds = perf_counter() - build_start
    bulk_load_end(driver, index, spec)
    indexed = verify_indexed(driver, index, imported, spec.dataset_id)
    return index, indexed, build_seconds


def _operating_point(driver, vec: VectorConfig, point: OperatingPoint, sweep: list[dict]) -> dict:
    tuning = point.tuning
    return {
        "knob": getattr(driver, "vector_knob", "efSearch"),
        "recall_metric": f"ann_recall@{vec.recall_k}",
        "recall_k": vec.recall_k,
        "target": tuning.target,
        "chosen_value": tuning.chosen_param,
        "rescore_oversample": point.oversample,
        "achieved_recall": tuning.achieved_recall,
        "met_target": tuning.met_target,
        "secondary_target": tuning.secondary_target,
        "secondary_value": tuning.secondary_param,
        "secondary_recall": tuning.secondary_recall,
        "tuning_sample_queries": point.sample_queries,
        "sample_recall": point.sample_recall,
        "confirmation_steps": point.confirmation_steps,
        "sweep": sweep,
    }


def _operational(indexed: int, build_seconds: float, ingest_rate: float, config: BenchmarkConfig, stats) -> dict:
    return {
        "documents_indexed": indexed,
        "build_seconds": build_seconds,
        "ingest_docs_per_sec": ingest_rate,
        "ingest_clients": config.import_clients,
        "ingest_batch_size": config.import_batch,
        "index_size_bytes": index_size_bytes(stats),
        "raw_stats": stats,
    }


def _score_run(driver, search, query_ids, config: BenchmarkConfig, qrels, run_path: Path, run_tag: str):
    if not qrels:
        return None, None
    run: dict[str, list[tuple[str, float]]] = {}
    run_for_scoring: dict[str, dict[str, float]] = {}
    for query_id in query_ids:
        ranked = strict_ranking(search(query_id).hits)
        run[query_id] = ranked
        run_for_scoring[query_id] = run_mapping(ranked)
    write_run_file(run_path, run, run_tag)
    return evaluate(qrels, run_for_scoring), str(run_path)


def _tune(driver, config: BenchmarkConfig, spec: DatasetSpec, profile: str, index: str, qset, query_vectors, truth, workload):
    vec = config.vector
    assert vec is not None
    label = f"[{driver.name}:{spec.dataset_id}:vector:{profile}]"
    grid = vec.ef_search_grid_best_config if profile == BEST_CONFIG else vec.ef_search_grid
    sample = sample_indices(len(qset.ids), vec.tuning_sample_queries)
    sample_ids = [qset.ids[i] for i in sample]

    def hits_at(i: int, ef: int) -> list[str]:
        response = driver.vector_search(index, query_vectors[i], vec.recall_k, ef)
        return [hit.doc_id for hit in response.hits[: vec.recall_k]]

    def run_at_sample(ef: int) -> dict[str, list[str]]:
        return {qset.ids[i]: hits_at(i, ef) for i in sample}

    def run_at_sample_oversample(oversample: float, ef: int) -> dict[str, list[str]]:
        driver.set_rescore_oversample(oversample)
        return run_at_sample(ef)

    def confirm(ef: int) -> tuple[Trip, dict[str, list[str]]]:
        approx: dict[str, list[str]] = {}
        search = request_caller(driver, replace(workload, ef=ef, top_k=max(workload.top_k, vec.recall_k)))

        def capture(i: int, response) -> None:
            approx[qset.ids[i]] = [hit.doc_id for hit in response.hits[: vec.recall_k]]

        return timed_trip(search, query_vectors, capture), approx

    if hasattr(driver, "set_rescore_oversample"):
        driver.set_rescore_oversample(None)
    print(f"{label} tuning to recall@{vec.recall_k} >= {vec.recall_target} on {len(sample_ids)} sampled queries", flush=True)
    return tune_operating_point(
        driver, profile, vec, grid, truth, sample_ids, run_at_sample, run_at_sample_oversample, confirm, label
    )


def run_vector_track(
    driver,
    engine_cfg: EngineConfig,
    config: BenchmarkConfig,
    spec: DatasetSpec,
    runs_dir: Path,
    store: EmbeddingStore,
    run_tag: str,
    profile: str = EQUAL_PRECISION,
    engine_cpu: CpuCounter | None = None,
) -> dict:
    vec = config.vector
    assert vec is not None
    label = f"[{driver.name}:{spec.dataset_id}:vector:{profile}]"
    print(f"{label} loading judgements and vectors", flush=True)
    qrels = ds.load_qrels(spec.dataset_id)
    qset = store.queries(spec.dataset_id)
    query_vectors = [qset.vectors[i].tolist() for i in range(len(qset.ids))]

    print(f"{label} ingesting corpus", flush=True)
    index, indexed, build_seconds = _create_and_load(driver, config, spec, store, profile)
    ingest_rate = indexed / build_seconds if build_seconds > 0 else 0.0
    truth = store.truth(spec.dataset_id, vec.recall_k)

    server_time = getattr(driver, "server_time", SERVER_TIME_UNAVAILABLE)
    workload = Workload(
        engine=engine_cfg,
        bm25=config.bm25,
        track=VECTOR,
        index=index,
        top_k=config.latency.top_k,
        vector_profile=profile,
        vector_metric=vec.metric,
    )
    point = _tune(driver, config, spec, profile, index, qset, query_vectors, truth, workload)
    workload = replace(workload, ef=point.tuning.chosen_param, rescore_oversample=point.oversample)

    sweep_config = replace(config.throughput, concurrency=(config.throughput.recall_sweep_concurrency,), passes=1)
    print(f"{label} measuring throughput at every search-effort level", flush=True)
    sweep = sweep_throughput(
        point.tuning.sweep,
        lambda ef: measure_throughput(replace(workload, ef=ef), query_vectors, sweep_config, server_time, engine_cpu),
    )

    quality_ef = max(point.tuning.chosen_param, config.run_depth)
    position = {query_id: i for i, query_id in enumerate(qset.ids)}
    metrics, run_file = _score_run(
        driver,
        lambda query_id: driver.vector_search(index, query_vectors[position[query_id]], config.run_depth, quality_ef),
        qset.ids,
        config,
        qrels,
        runs_dir / f"{index}.{run_tag}.run",
        run_tag,
    )

    print(f"{label} measuring latency and throughput at the operating point", flush=True)
    vector_once = request_caller(driver, workload)
    prior = [point.confirm_trip] if vec.recall_k <= config.latency.top_k else []
    latency = measure_latency(vector_once, query_vectors, config.latency, server_time, (), prior)
    throughput = measure_throughput(workload, query_vectors, config.throughput, server_time, engine_cpu)

    stats = best_effort(lambda: driver.index_stats(index), "index stats")
    setup_report = server_setup(driver)
    driver.drop_index(index)

    return {
        "dataset_id": spec.dataset_id,
        "dataset_identity": ds.dataset_content_id(spec.dataset_id),
        "track": VECTOR,
        "run_tag": run_tag,
        "vector_profile": profile,
        "setup": getattr(driver, "vector_setup", ""),
        "server_setup": setup_report,
        "quantization": getattr(driver, "vector_quantization", None),
        "vector_model": store.model_for(spec.dataset_id),
        "vector_dims": store.dims_for(spec.dataset_id),
        "queries": len(qset.ids),
        "judged_queries": len(qrels),
        "metrics": metrics,
        "calibration": None,
        "operating_point": _operating_point(driver, vec, point, sweep),
        "vector_oversample": point.oversample,
        "operational": _operational(indexed, build_seconds, ingest_rate, config, stats),
        "latency": latency,
        "throughput": throughput,
        "run_file": run_file,
    }


def run_hybrid_track(
    driver,
    engine_cfg: EngineConfig,
    config: BenchmarkConfig,
    spec: DatasetSpec,
    runs_dir: Path,
    store: EmbeddingStore,
    run_tag: str,
    vector_ef: int | None,
    profile: str = EQUAL_PRECISION,
    vector_oversample: float | None = None,
    engine_cpu: CpuCounter | None = None,
) -> dict:
    vec = config.vector
    assert vec is not None
    label = f"[{driver.name}:{spec.dataset_id}:hybrid:{profile}]"
    print(f"{label} loading queries, judgements, vectors", flush=True)
    terms = ds.load_queries(spec.dataset_id)
    qrels = ds.load_qrels(spec.dataset_id)
    qset = store.queries(spec.dataset_id)
    query_terms = {query_id: terms.get(query_id, "") for query_id in qset.ids}
    query_vectors = {query_id: qset.vectors[i].tolist() for i, query_id in enumerate(qset.ids)}

    print(f"{label} ingesting corpus", flush=True)
    index, indexed, build_seconds = _create_and_load(driver, config, spec, store, profile)
    ingest_rate = indexed / build_seconds if build_seconds > 0 else 0.0
    if hasattr(driver, "set_rescore_oversample"):
        driver.set_rescore_oversample(vector_oversample)

    grid = vec.ef_search_grid_best_config if profile == BEST_CONFIG else vec.ef_search_grid
    operating_ef = vector_ef if vector_ef is not None else grid[-1]
    quality_ef = max(operating_ef, config.run_depth)
    metrics, run_file = _score_run(
        driver,
        lambda query_id: driver.hybrid_search(
            index, query_terms[query_id], query_vectors[query_id], config.run_depth, quality_ef
        ),
        qset.ids,
        config,
        qrels,
        runs_dir / f"{index}.{run_tag}.run",
        run_tag,
    )

    print(f"{label} measuring latency and throughput", flush=True)
    server_time = getattr(driver, "server_time", SERVER_TIME_UNAVAILABLE)
    pairs = [(query_terms[query_id], query_vectors[query_id]) for query_id in qset.ids]

    workload = Workload(
        engine=engine_cfg,
        bm25=config.bm25,
        track=HYBRID,
        index=index,
        top_k=config.latency.top_k,
        ef=operating_ef,
        vector_profile=profile,
        vector_metric=vec.metric,
        rescore_oversample=vector_oversample,
    )
    hybrid_once = request_caller(driver, workload)
    warmup = [] if metrics is not None else warmup_sample(config.latency, pairs)
    latency = measure_latency(hybrid_once, pairs, config.latency, server_time, warmup)
    throughput = measure_throughput(workload, pairs, config.throughput, server_time, engine_cpu)

    stats = best_effort(lambda: driver.index_stats(index), "index stats")
    setup_report = server_setup(driver)
    driver.drop_index(index)

    return {
        "dataset_id": spec.dataset_id,
        "dataset_identity": ds.dataset_content_id(spec.dataset_id),
        "track": HYBRID,
        "run_tag": run_tag,
        "vector_profile": profile,
        "setup": getattr(driver, "hybrid_setup", ""),
        "server_setup": setup_report,
        "quantization": getattr(driver, "vector_quantization", None),
        "vector_model": store.model_for(spec.dataset_id),
        "vector_dims": store.dims_for(spec.dataset_id),
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
        "operational": _operational(indexed, build_seconds, ingest_rate, config, stats),
        "latency": latency,
        "throughput": throughput,
        "run_file": run_file,
    }
