from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Iterator
from pathlib import Path

import numpy as np

from .core.artifacts import download_file, read_remote
from .core.embedding_files import l2_normalize

DBPEDIA_SOURCE = "KShivendu/dbpedia-entities-openai-1M"
DBPEDIA_MODEL = "text-embedding-ada-002"
DBPEDIA_DIMS = 1536
DBPEDIA_COLUMNS = ("_id", "title", "text", "openai")
HUB_PARQUET_DIRECTORY = "data"
HUB_TREE_URL = "https://huggingface.co/api/datasets/{repo}/tree/main/{directory}"
HUB_RESOLVE_URL = "https://huggingface.co/datasets/{repo}/resolve/main/{path}"
PARQUET_SUFFIX = ".parquet"


def hub_parquet_files(repo: str = DBPEDIA_SOURCE, read: Callable[[str], bytes] = read_remote) -> list[str]:
    body = json.loads(read(HUB_TREE_URL.format(repo=repo, directory=HUB_PARQUET_DIRECTORY)))
    if not isinstance(body, list):
        raise SystemExit(f"the file listing for {repo} is not a list")
    paths = sorted(
        str(entry.get("path"))
        for entry in body
        if isinstance(entry, dict) and str(entry.get("path", "")).endswith(PARQUET_SUFFIX)
    )
    if not paths:
        raise SystemExit(f"{repo} lists no parquet files under {HUB_PARQUET_DIRECTORY}/")
    return paths


def hub_parquet_url(path: str, repo: str = DBPEDIA_SOURCE) -> str:
    return HUB_RESOLVE_URL.format(repo=repo, path=path)


def local_parquet_files(parquet_dir: Path) -> list[Path]:
    files = sorted(Path(parquet_dir).glob(f"*{PARQUET_SUFFIX}"))
    if not files:
        raise SystemExit(f"no parquet files under {parquet_dir}")
    return files


def streamed_hub_parquet(work_dir: Path, repo: str = DBPEDIA_SOURCE) -> Iterator[Path]:
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    for path in hub_parquet_files(repo):
        target = work_dir / Path(path).name
        print(f"  downloading {path}", flush=True)
        download_file(hub_parquet_url(path, repo), target)
        try:
            yield target
        finally:
            target.unlink(missing_ok=True)


def read_parquet_rows(files: Iterable[Path], wanted: int) -> tuple[list[str], list[str], list[str], np.ndarray]:
    import pyarrow.parquet as pq

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
    close = getattr(files, "close", None)
    if callable(close):
        close()
    if filled < wanted:
        raise SystemExit(f"the parquet source holds {filled} rows, fewer than the {wanted} requested")
    return source_ids, titles, texts, l2_normalize(vectors)
