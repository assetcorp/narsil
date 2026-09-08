from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Iterator

from .artifacts import ARTIFACT_MANIFEST, DOCUMENTS_FILENAME, QRELS_FILENAME, QUERIES_FILENAME, read_manifest, sha256_of


def _lines(path: Path) -> Iterator[dict]:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def document_text(title: str, text: str) -> str:
    title = (title or "").strip()
    text = (text or "").strip()
    if title and text:
        return f"{title} {text}"
    return title or text


def iter_documents(directory: Path) -> Iterator[tuple[str, str]]:
    for record in _lines(Path(directory) / DOCUMENTS_FILENAME):
        body = document_text(str(record.get("title") or ""), str(record.get("text") or ""))
        if body:
            yield str(record["id"]), body


def document_count(directory: Path) -> int:
    manifest = read_manifest(directory) or {}
    count = manifest.get("documents")
    if isinstance(count, int) and count >= 0:
        return count
    return sum(1 for _ in iter_documents(directory))


def load_queries(directory: Path) -> dict[str, str]:
    queries: dict[str, str] = {}
    for record in _lines(Path(directory) / QUERIES_FILENAME):
        text = str(record.get("text") or "").strip()
        if text:
            queries[str(record["id"])] = text
    return queries


def load_qrels(directory: Path) -> dict[str, dict[str, int]]:
    path = Path(directory) / QRELS_FILENAME
    qrels: dict[str, dict[str, int]] = {}
    if not path.is_file():
        return qrels
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3 or not parts[0].strip():
                continue
            qrels.setdefault(parts[0], {})[parts[1]] = int(parts[2])
    return qrels


def archive_identity(directory: Path) -> dict:
    manifest = read_manifest(directory) or {}
    manifest_path = Path(directory) / ARTIFACT_MANIFEST
    return {
        "source": "artifact",
        "artifact_sha256": sha256_of(manifest_path) if manifest_path.is_file() else None,
        "origin": manifest.get("source"),
        "vector_model": manifest.get("vector_model"),
        "vector_dims": manifest.get("vector_dims"),
    }
