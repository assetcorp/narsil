from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from time import perf_counter

from . import datasets as ds
from .config import BenchmarkConfig
from .config_datasets import DatasetSpec
from .runfile import run_mapping, strict_ranking, write_run_file
from .scoring import evaluate
from .synonym_sets import SynonymRule
from .track_common import bulk_load_begin, bulk_load_end, index_name, verify_indexed, wait_for_checkpoint


@dataclass(frozen=True)
class LoadedIndex:
    name: str
    documents: int
    build_seconds: float


@dataclass(frozen=True)
class QueryScores:
    metrics: dict[str, float] | None
    run_file: str | None


def load_keyword_index(
    driver,
    config: BenchmarkConfig,
    spec: DatasetSpec,
    label: str,
    synonyms: tuple[SynonymRule, ...] | None = None,
) -> LoadedIndex:
    index = index_name(spec.dataset_id)
    driver.drop_index(index)
    if synonyms is None:
        driver.create_index(index)
    else:
        driver.create_index(index, synonyms)

    print(f"[{label}] ingesting corpus", flush=True)
    bulk_load_begin(driver, index, spec)
    build_start = perf_counter()
    imported = driver.import_documents(
        index, ds.iter_documents(spec.dataset_id), config.import_batch, config.import_clients
    )
    build_seconds = perf_counter() - build_start
    bulk_load_end(driver, index, spec)
    indexed = verify_indexed(driver, index, imported, spec.dataset_id)
    wait_for_checkpoint(driver, index)
    return LoadedIndex(name=index, documents=indexed, build_seconds=build_seconds)


def score_keyword_queries(
    driver,
    index: str,
    queries: dict[str, str],
    qrels: dict[str, dict[str, int]],
    run_depth: int,
    run_path: Path,
    label: str,
) -> QueryScores:
    if not qrels:
        return QueryScores(metrics=None, run_file=None)
    print(f"[{label}] running {len(queries)} queries", flush=True)
    run: dict[str, list[tuple[str, float]]] = {}
    run_for_scoring: dict[str, dict[str, float]] = {}
    for query_id, term in queries.items():
        response = driver.search(index, term, run_depth)
        ranked = strict_ranking(response.hits)
        run[query_id] = ranked
        run_for_scoring[query_id] = run_mapping(ranked)
    write_run_file(run_path, run, driver.run_tag)
    return QueryScores(metrics=evaluate(qrels, run_for_scoring), run_file=str(run_path))
