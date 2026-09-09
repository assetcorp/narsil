from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

STORE_MANIFEST = "manifest.json"
SHARD_ROWS = 50_000
NORMALIZE_BLOCK_ROWS = 50_000


def l2_normalize(matrix: np.ndarray) -> np.ndarray:
    normalized = matrix if matrix.dtype == np.float32 else matrix.astype(np.float32)
    for start in range(0, normalized.shape[0], NORMALIZE_BLOCK_ROWS):
        rows = normalized[start : start + NORMALIZE_BLOCK_ROWS]
        norms = np.linalg.norm(rows, axis=1, keepdims=True)
        norms[norms == 0.0] = 1.0
        rows /= norms
    return normalized


def _fsync_path(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def read_store_manifest(dirpath: Path) -> dict | None:
    path = dirpath / STORE_MANIFEST
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def write_store_manifest(dirpath: Path, data: dict) -> None:
    tmp = dirpath / f".{STORE_MANIFEST}.tmp"
    tmp.write_text(json.dumps(data), encoding="utf-8")
    _fsync_path(tmp)
    os.replace(tmp, dirpath / STORE_MANIFEST)
    _fsync_dir(dirpath)


def shard_path(dirpath: Path, index: int) -> Path:
    return dirpath / f"shard_{index:05d}.npz"


def write_shard(dirpath: Path, index: int, ids: list[str], vectors: np.ndarray) -> None:
    tmp = dirpath / f".shard_{index:05d}.npz.tmp"
    with open(tmp, "wb") as handle:
        np.savez(handle, ids=np.asarray(ids, dtype=np.str_), vectors=vectors.astype(np.float32, copy=False))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, shard_path(dirpath, index))
    _fsync_dir(dirpath)


def read_shard(dirpath: Path, index: int) -> tuple[list[str], np.ndarray]:
    with np.load(shard_path(dirpath, index), allow_pickle=False) as data:
        ids = [str(value) for value in data["ids"].tolist()]
        vectors = data["vectors"]
    return ids, vectors


def _shard_index(path: Path) -> int:
    return int(path.stem.split("_")[1])


def remove_orphans(dirpath: Path, valid_shards: int) -> None:
    for shard in dirpath.glob("shard_*.npz"):
        if _shard_index(shard) >= valid_shards:
            shard.unlink()
    for stray in dirpath.glob(".shard_*"):
        stray.unlink()


def reset_dir(dirpath: Path) -> None:
    for shard in dirpath.glob("shard_*.npz"):
        shard.unlink()
    for stray in dirpath.glob(".shard_*"):
        stray.unlink()
    manifest = dirpath / STORE_MANIFEST
    if manifest.exists():
        manifest.unlink()


def store_manifest(model: str, dims: int, kind: str, raw_consumed: int, rows: int, shards: int, complete: bool) -> dict:
    return {
        "model": model,
        "dims": dims,
        "kind": kind,
        "raw_consumed": raw_consumed,
        "rows": rows,
        "shards": shards,
        "complete": complete,
    }


def write_truth(path: Path, query_ids: list[str], truth: dict[str, list[str]], k: int) -> None:
    neighbors = np.full((len(query_ids), k), "", dtype=object)
    for row, query_id in enumerate(query_ids):
        hits = truth.get(query_id, [])
        for column in range(min(k, len(hits))):
            neighbors[row, column] = hits[column]
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(path, query_ids=np.asarray(query_ids, dtype=np.str_), neighbors=neighbors.astype(np.str_))


def read_truth(path: Path, query_ids: list[str]) -> dict[str, list[str]] | None:
    if not path.exists():
        return None
    try:
        with np.load(path, allow_pickle=False) as data:
            cached_ids = [str(value) for value in data["query_ids"].tolist()]
            neighbors = data["neighbors"].tolist()
    except (ValueError, OSError, KeyError):
        return None
    if cached_ids != query_ids:
        return None
    return {query_id: [doc_id for doc_id in row if doc_id] for query_id, row in zip(cached_ids, neighbors)}
