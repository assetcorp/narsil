from __future__ import annotations

import argparse
import gzip
import json
import random
import shutil
import sys
from pathlib import Path

import numpy as np

from .core.artifacts import (
    DOCS_DIRNAME,
    DOCUMENTS_FILENAME,
    QUERIES_DIRNAME,
    QUERIES_FILENAME,
    dataset_slug,
    truth_filename,
    write_manifest,
)
from .core.config import load_config
from .core.config_datasets import ARTIFACT_SOURCE, IR_DATASETS_SOURCE
from .core.embedding_files import SHARD_ROWS, l2_normalize, store_manifest, write_shard, write_store_manifest, write_truth
from .core.embeddings import EmbeddingStore
from .core.ground_truth import exact_top_k

HOLD_OUT_SEED = 42
DBPEDIA_SOURCE = "KShivendu/dbpedia-entities-openai-1M"
DBPEDIA_MODEL = "text-embedding-ada-002"
DBPEDIA_DIMS = 1536
DBPEDIA_COLUMNS = ("_id", "title", "text", "openai")


def _write_jsonl_gz(path: Path, records) -> int:
    count = 0
    with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as compressed:
        for record in records:
            compressed.write((json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8"))
            count += 1
    return count


def _write_store(directory: Path, model: str, dims: int, kind: str, ids: list[str], vectors: np.ndarray) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    shards = 0
    for start in range(0, len(ids), SHARD_ROWS):
        write_shard(directory, shards, ids[start : start + SHARD_ROWS], vectors[start : start + SHARD_ROWS])
        shards += 1
    write_store_manifest(directory, store_manifest(model, dims, kind, len(ids), len(ids), shards, True))


def _read_parquet_rows(parquet_dir: Path, wanted: int) -> tuple[list[str], list[str], list[str], np.ndarray]:
    import pyarrow.parquet as pq

    files = sorted(Path(parquet_dir).glob("*.parquet"))
    if not files:
        raise SystemExit(f"no parquet files under {parquet_dir}")
    source_ids: list[str] = []
    titles: list[str] = []
    texts: list[str] = []
    vectors = np.empty((wanted, DBPEDIA_DIMS), dtype=np.float32)
    filled = 0
    for path in files:
        table = pq.read_table(path, columns=list(DBPEDIA_COLUMNS))
        block = np.asarray(table["openai"].combine_chunks().flatten(), dtype=np.float32).reshape(-1, DBPEDIA_DIMS)
        take = min(len(block), wanted - filled)
        vectors[filled : filled + take] = block[:take]
        filled += take
        source_ids.extend(table["_id"].to_pylist()[:take])
        titles.extend(table["title"].to_pylist()[:take])
        texts.extend(table["text"].to_pylist()[:take])
        print(f"  read {filled} rows", flush=True)
        if filled >= wanted:
            break
    if filled < wanted:
        raise SystemExit(f"{parquet_dir} holds {filled} rows, fewer than the {wanted} requested")
    return source_ids, titles, texts, l2_normalize(vectors)


def build_dbpedia(args: argparse.Namespace) -> int:
    total = args.documents + args.queries
    print(f"reading {total} rows from {args.parquet_dir}", flush=True)
    source_ids, titles, texts, vectors = _read_parquet_rows(args.parquet_dir, total)
    held_out = set(random.Random(HOLD_OUT_SEED).sample(range(total), args.queries))
    doc_rows = [row for row in range(total) if row not in held_out]
    query_rows = sorted(held_out)
    ids = [str(row) for row in range(total)]

    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    print(f"writing {len(doc_rows)} documents and {len(query_rows)} held-out queries", flush=True)
    documents = _write_jsonl_gz(
        out / DOCUMENTS_FILENAME,
        ({"id": ids[row], "source_id": source_ids[row], "title": titles[row], "text": texts[row]} for row in doc_rows),
    )
    queries = _write_jsonl_gz(
        out / QUERIES_FILENAME,
        ({"id": ids[row], "source_id": source_ids[row], "text": titles[row]} for row in query_rows),
    )
    doc_ids = [ids[row] for row in doc_rows]
    query_ids = [ids[row] for row in query_rows]
    doc_vectors = vectors[doc_rows]
    query_vectors = vectors[query_rows]
    _write_store(out / DOCS_DIRNAME, DBPEDIA_MODEL, DBPEDIA_DIMS, "docs", doc_ids, doc_vectors)
    _write_store(out / QUERIES_DIRNAME, DBPEDIA_MODEL, DBPEDIA_DIMS, "queries", query_ids, query_vectors)
    print(f"computing exact top-{args.recall_k} neighbours for {queries} queries over {documents} documents", flush=True)
    truth = exact_top_k(query_ids, query_vectors, doc_ids, doc_vectors, args.recall_k)
    write_truth(out / truth_filename(args.recall_k), query_ids, truth, args.recall_k)

    digest = write_manifest(
        out,
        args.dataset_id,
        {
            "source": {
                "dataset": DBPEDIA_SOURCE,
                "rows": f"first {total} rows in parquet order",
                "hold_out": f"{args.queries} rows chosen with seed {HOLD_OUT_SEED}",
                "query_text": "entity title",
            },
            "kind": ARTIFACT_SOURCE,
            "vector_model": DBPEDIA_MODEL,
            "vector_dims": DBPEDIA_DIMS,
            "documents": documents,
            "queries": queries,
            "recall_k": args.recall_k,
        },
    )
    print(f"artifact written to {out}\nartifact_sha256 = \"{digest}\"", flush=True)
    return 0


def build_beir_vectors(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    if config.vector is None:
        raise SystemExit("the config has no [vector] section")
    store = EmbeddingStore(config.vector, args.embeddings_dir)
    corpus = store.corpus(args.dataset_id)
    queries = store.queries(args.dataset_id)
    truth = store.truth(args.dataset_id, config.vector.recall_k)
    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    _write_store(out / DOCS_DIRNAME, config.vector.model, config.vector.dims, "docs", corpus.ids, corpus.vectors)
    _write_store(out / QUERIES_DIRNAME, config.vector.model, config.vector.dims, "queries", queries.ids, queries.vectors)
    write_truth(out / truth_filename(config.vector.recall_k), queries.ids, truth, config.vector.recall_k)
    digest = write_manifest(
        out,
        args.dataset_id,
        {
            "source": {"dataset": args.dataset_id, "text": "ir_datasets", "vectors": "computed by the harness embed step"},
            "kind": IR_DATASETS_SOURCE,
            "vector_model": config.vector.model,
            "vector_dims": config.vector.dims,
            "documents": len(corpus.ids),
            "queries": len(queries.ids),
            "recall_k": config.vector.recall_k,
        },
    )
    print(f"artifact written to {out}\nartifact_sha256 = \"{digest}\"", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build a published dataset artifact the harness fetches by digest.")
    commands = parser.add_subparsers(dest="command", required=True)

    dbpedia = commands.add_parser("dbpedia", help="documents, held-out queries, vectors, and exact neighbours from the DBpedia entities parquet files")
    dbpedia.add_argument("--parquet-dir", type=Path, required=True)
    dbpedia.add_argument("--dataset-id", required=True)
    dbpedia.add_argument("--documents", type=int, required=True)
    dbpedia.add_argument("--queries", type=int, default=5000)
    dbpedia.add_argument("--recall-k", type=int, default=10)
    dbpedia.add_argument("--out", type=Path, default=None)
    dbpedia.set_defaults(run=build_dbpedia)

    beir = commands.add_parser("beir-vectors", help="the harness's own computed vectors and neighbours for an ir_datasets set")
    beir.add_argument("--config", type=Path, default=Path("config/benchmark.toml"))
    beir.add_argument("--embeddings-dir", type=Path, required=True)
    beir.add_argument("--dataset-id", required=True)
    beir.add_argument("--out", type=Path, default=None)
    beir.set_defaults(run=build_beir_vectors)

    args = parser.parse_args(argv)
    if args.out is None:
        args.out = Path("artifacts") / dataset_slug(args.dataset_id)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
