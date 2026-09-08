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
from .core.embedding_files import SHARD_ROWS, store_manifest, write_shard, write_store_manifest, write_truth
from .core.embeddings import EmbeddingStore
from .core.ground_truth import exact_top_k
from .dbpedia_parquet import (
    DBPEDIA_DIMS,
    DBPEDIA_MODEL,
    DBPEDIA_SOURCE,
    local_parquet_files,
    read_parquet_rows,
    streamed_hub_parquet,
)

HOLD_OUT_SEED = 42
HUB_WORK_DIRNAME = ".source"


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


def _parquet_files(args: argparse.Namespace):
    if args.parquet_dir is not None:
        print(f"reading parquet files under {args.parquet_dir}", flush=True)
        return local_parquet_files(args.parquet_dir)
    work_dir = Path(args.work_dir) if args.work_dir is not None else Path(args.out).parent / HUB_WORK_DIRNAME
    print(f"streaming parquet files from {DBPEDIA_SOURCE} through {work_dir}", flush=True)
    return streamed_hub_parquet(work_dir)


def build_dbpedia(args: argparse.Namespace) -> int:
    if (args.parquet_dir is None) == (not args.from_hub):
        raise SystemExit("pass exactly one of --parquet-dir and --from-hub")
    total = args.documents + args.queries
    print(f"reading {total} rows", flush=True)
    source_ids, titles, texts, vectors = read_parquet_rows(_parquet_files(args), total)
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
    dbpedia.add_argument("--parquet-dir", type=Path, default=None)
    dbpedia.add_argument("--from-hub", action="store_true", help=f"download each parquet file of {DBPEDIA_SOURCE} in turn and delete it once read")
    dbpedia.add_argument("--work-dir", type=Path, default=None, help="where --from-hub keeps the file being read")
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
