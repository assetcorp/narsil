from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

from .core import datasets as ds
from .core.config import BenchmarkConfig, EngineConfig, load_config, select_datasets, select_engine
from .core.embeddings import EmbeddingStore
from .core.engine_memory import read_engine_memory
from .core.keyword_relevance import load_keyword_index
from .core.registry import build_driver
from .core.reporter import write_json
from .core.run_store import resolve_run_id_for_write, run_directory, validate_engine_name
from .core.types import EQUAL_PRECISION, KEYWORD, EngineError
from .core.vector_runner import load_vector_index

RESULT_PREFIX = "restart-"
ANSWER_WAIT_SECONDS = 1800.0
START_RECORD_WAIT_SECONDS = 60.0
POLL_SECONDS = 0.005
SEARCH_LIMIT = 10
SEARCHES_BEFORE_SETTLED_MEMORY = 25


def _paths(directory: Path, engine: str) -> dict[str, Path]:
    return {
        "state": directory / f".{RESULT_PREFIX}{engine}.state.json",
        "watching": directory / f".{RESULT_PREFIX}{engine}.watching",
        "started": directory / f".{RESULT_PREFIX}{engine}.started",
        "result": directory / f"{RESULT_PREFIX}{engine}.json",
    }


def _search_once(driver, state: dict):
    if state["track"] == KEYWORD:
        return driver.search(state["index"], state["term"], SEARCH_LIMIT)
    return driver.vector_search(state["index"], state["vector"], SEARCH_LIMIT, None)


def _store_for(config: BenchmarkConfig) -> EmbeddingStore:
    if config.vector is None:
        raise SystemExit("a vector-only engine needs a [vector] config section")
    embeddings = Path(os.environ.get("BENCH_EMBEDDINGS_DIR", "/data/embeddings"))
    return EmbeddingStore(config.vector, embeddings, config.datasets)


def _prepare(driver, engine: EngineConfig, config: BenchmarkConfig, paths: dict[str, Path], dataset: str | None) -> None:
    specs = select_datasets(config, dataset or os.environ.get("BENCH_DATASETS"))
    spec = specs[-1]
    label = f"{engine.name}:{spec.dataset_id}:restart"
    driver.wait_until_ready()
    if KEYWORD in engine.tracks:
        loaded = load_keyword_index(driver, config, spec, label)
        index, documents = loaded.name, loaded.documents
        state = {"track": KEYWORD, "index": index}
        for term in ds.load_queries(spec.dataset_id).values():
            if driver.search(index, term, SEARCH_LIMIT).hits:
                state["term"] = term
                break
        if "term" not in state:
            raise EngineError(f"no query of {spec.dataset_id} found a document in {engine.name}")
    else:
        store = _store_for(config)
        index, documents, _ = load_vector_index(driver, config, spec, store, EQUAL_PRECISION)
        state = {"track": "vector", "index": index, "vector": list(next(iter(store.vector_by_id(spec.dataset_id).values())))}
    state.update(
        {
            "dataset_id": spec.dataset_id,
            "documents": documents,
            "memory_before_restart": read_engine_memory(os.environ),
        }
    )
    write_json(paths["state"], state)


def _started_at(path: Path) -> float:
    deadline = time.monotonic() + START_RECORD_WAIT_SECONDS
    while time.monotonic() < deadline:
        if path.is_file():
            text = path.read_text(encoding="utf-8").strip()
            if text:
                seconds, _, fraction = text.rstrip("Z").partition(".")
                whole = datetime.fromisoformat(f"{seconds}+00:00").timestamp()
                return whole + float(f"0.{fraction or '0'}")
        time.sleep(POLL_SECONDS)
    raise SystemExit(f"no start time arrived in {path}")


def _watch(driver, engine: EngineConfig, config: BenchmarkConfig, paths: dict[str, Path]) -> None:
    state = json.loads(paths["state"].read_text(encoding="utf-8"))
    if config.vector is not None and hasattr(driver, "set_vector_metric"):
        driver.set_vector_metric(config.vector.metric)
    paths["watching"].write_text("watching\n", encoding="utf-8")
    deadline = time.monotonic() + ANSWER_WAIT_SECONDS
    answered = None
    attempts = 0
    while time.monotonic() < deadline:
        attempts += 1
        before = time.perf_counter()
        try:
            response = _search_once(driver, state)
        except (httpx.HTTPError, EngineError):
            time.sleep(POLL_SECONDS)
            continue
        if not response.hits:
            time.sleep(POLL_SECONDS)
            continue
        answered = {"answered_at": time.time(), "query_ms": (time.perf_counter() - before) * 1000}
        break
    if answered is None:
        raise SystemExit(f"{engine.name} answered no search within {ANSWER_WAIT_SECONDS} seconds of its restart")
    memory_at_first_answer = read_engine_memory(os.environ)
    for _ in range(SEARCHES_BEFORE_SETTLED_MEMORY):
        _search_once(driver, state)
    started_at = _started_at(paths["started"])
    write_json(
        paths["result"],
        {
            "engine": engine.name,
            "storage": engine.storage,
            "dataset_id": state["dataset_id"],
            "track": state["track"],
            "documents": state["documents"],
            "page_cache_dropped": os.environ.get("BENCH_RESTART_CACHE_DROPPED") == "1",
            "first_search_seconds": answered["answered_at"] - started_at,
            "first_query_ms": answered["query_ms"],
            "attempts": attempts,
            "memory_before_restart": state["memory_before_restart"],
            "memory_at_first_answer": memory_at_first_answer,
            "memory_after_searches": read_engine_memory(os.environ),
        },
    )
    for name in ("state", "watching", "started"):
        paths[name].unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Time an engine's first search after a restart, and its memory.")
    parser.add_argument("step", choices=("prepare", "watch"))
    parser.add_argument("--config", type=Path, default=Path("config/benchmark.toml"))
    parser.add_argument("--results-dir", type=Path, default=Path("results"))
    parser.add_argument("--engine", default=None)
    parser.add_argument("--dataset", default=None)
    args = parser.parse_args(argv)

    config = load_config(args.config)
    embeddings = Path(os.environ.get("BENCH_EMBEDDINGS_DIR", "/data/embeddings"))
    ds.configure(config.datasets, embeddings)
    engine = select_engine(config, args.engine)
    try:
        directory = run_directory(args.results_dir, resolve_run_id_for_write(None))
        paths = _paths(directory, validate_engine_name(engine.name))
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    directory.mkdir(parents=True, exist_ok=True)
    driver = build_driver(engine, config.bm25)
    try:
        if args.step == "prepare":
            _prepare(driver, engine, config, paths, args.dataset)
        else:
            _watch(driver, engine, config, paths)
    finally:
        driver.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
