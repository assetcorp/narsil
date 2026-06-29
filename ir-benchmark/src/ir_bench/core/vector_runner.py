from __future__ import annotations

from pathlib import Path
from time import perf_counter

from . import datasets as ds
from .config import BenchmarkConfig, DatasetSpec, VectorConfig
from .embeddings import EmbeddingStore
from .ground_truth import exact_top_k
from .latency import measure_latency
from .recall_tuning import TuningResult, tune_to_recall
from .runfile import run_mapping, strict_ranking, write_run_file
from .scoring import evaluate
from .track_common import best_effort, index_name, index_size_bytes, verify_indexed
from .types import HYBRID, VECTOR, VectorDoc, VectorIndexParams


def _create_and_load(driver, config: BenchmarkConfig, spec: DatasetSpec, store: EmbeddingStore) -> tuple[str, int, float]:
    vec = config.vector
    assert vec is not None
    index = index_name(spec.dataset_id)
    params = VectorIndexParams(dims=vec.dims, metric=vec.metric, m=vec.hnsw_m, ef_construction=vec.hnsw_ef_construction)
    vector_by_id = store.vector_by_id(spec.dataset_id)

    def documents():
        for doc_id, text in ds.iter_documents(spec.dataset_id):
            yield VectorDoc(doc_id=doc_id, text=text, vector=vector_by_id[doc_id].tolist())

    driver.drop_index(index)
    driver.create_vector_index(index, params)
    build_start = perf_counter()
    imported = driver.import_vectors(index, documents(), config.import_batch)
    driver.build_vectors(index)
    build_seconds = perf_counter() - build_start
    indexed = verify_indexed(driver, index, imported, spec.dataset_id)
    return index, indexed, build_seconds


def _operating_point(driver, vec: VectorConfig, tuning: TuningResult) -> dict:
    return {
        "knob": getattr(driver, "vector_knob", "efSearch"),
        "recall_metric": f"ann_recall@{vec.recall_k}",
        "recall_k": vec.recall_k,
        "target": tuning.target,
        "chosen_value": tuning.chosen_param,
        "achieved_recall": tuning.achieved_recall,
        "met_target": tuning.met_target,
        "secondary_target": tuning.secondary_target,
        "secondary_value": tuning.secondary_param,
        "secondary_recall": tuning.secondary_recall,
        "sweep": [{"value": point.param, "recall": point.recall} for point in tuning.sweep],
    }


def run_vector_track(
    driver, config: BenchmarkConfig, spec: DatasetSpec, runs_dir: Path, store: EmbeddingStore, run_tag: str
) -> dict:
    vec = config.vector
    assert vec is not None
    print(f"[{driver.name}:{spec.dataset_id}:vector] loading judgements and vectors", flush=True)
    qrels = ds.load_qrels(spec.dataset_id)
    corpus = store.corpus(spec.dataset_id)
    qset = store.queries(spec.dataset_id)
    query_vectors = [qset.vectors[i].tolist() for i in range(len(qset.ids))]

    print(f"[{driver.name}:{spec.dataset_id}:vector] ingesting corpus", flush=True)
    index, indexed, build_seconds = _create_and_load(driver, config, spec, store)
    ingest_rate = indexed / build_seconds if build_seconds > 0 else 0.0

    truth = exact_top_k(qset.ids, qset.vectors, corpus.ids, corpus.vectors, vec.recall_k)

    def run_at(ef: int) -> dict[str, list[str]]:
        approx: dict[str, list[str]] = {}
        for i, query_id in enumerate(qset.ids):
            response = driver.vector_search(index, query_vectors[i], vec.recall_k, ef)
            approx[query_id] = [hit.doc_id for hit in response.hits[: vec.recall_k]]
        return approx

    print(f"[{driver.name}:{spec.dataset_id}:vector] tuning to recall@{vec.recall_k} >= {vec.recall_target}", flush=True)
    tuning = tune_to_recall(
        run_at, vec.ef_search_grid, truth, vec.recall_k, vec.recall_target, vec.recall_target_secondary
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

    print(f"[{driver.name}:{spec.dataset_id}:vector] measuring latency at the operating point", flush=True)
    latency = measure_latency(
        lambda vector: driver.vector_search(index, vector, config.latency.top_k, tuning.chosen_param),
        query_vectors,
        config.latency,
    )

    stats = best_effort(lambda: driver.index_stats(index), "index stats")
    driver.drop_index(index)

    return {
        "dataset_id": spec.dataset_id,
        "track": VECTOR,
        "run_tag": run_tag,
        "setup": getattr(driver, "vector_setup", ""),
        "queries": len(qset.ids),
        "judged_queries": len(qrels),
        "metrics": metrics,
        "calibration": None,
        "operating_point": _operating_point(driver, vec, tuning),
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


def run_hybrid_track(
    driver,
    config: BenchmarkConfig,
    spec: DatasetSpec,
    runs_dir: Path,
    store: EmbeddingStore,
    run_tag: str,
    vector_ef: int | None,
) -> dict:
    vec = config.vector
    assert vec is not None
    print(f"[{driver.name}:{spec.dataset_id}:hybrid] loading queries, judgements, vectors", flush=True)
    terms = ds.load_queries(spec.dataset_id)
    qrels = ds.load_qrels(spec.dataset_id)
    qset = store.queries(spec.dataset_id)
    query_terms = {query_id: terms.get(query_id, "") for query_id in qset.ids}
    query_vectors = {query_id: qset.vectors[i].tolist() for i, query_id in enumerate(qset.ids)}

    print(f"[{driver.name}:{spec.dataset_id}:hybrid] ingesting corpus", flush=True)
    index, indexed, build_seconds = _create_and_load(driver, config, spec, store)
    ingest_rate = indexed / build_seconds if build_seconds > 0 else 0.0

    operating_ef = vector_ef if vector_ef is not None else vec.ef_search_grid[-1]
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

    print(f"[{driver.name}:{spec.dataset_id}:hybrid] measuring latency", flush=True)
    latency = measure_latency(
        lambda query_id: driver.hybrid_search(
            index, query_terms[query_id], query_vectors[query_id], config.latency.top_k, operating_ef
        ),
        list(qset.ids),
        config.latency,
    )

    stats = best_effort(lambda: driver.index_stats(index), "index stats")
    driver.drop_index(index)

    return {
        "dataset_id": spec.dataset_id,
        "track": HYBRID,
        "run_tag": run_tag,
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
        },
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
