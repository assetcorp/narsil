from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import httpx

from .config_datasets import DatasetSpec

ARTIFACT_FORMAT = "narsil-benchmark-dataset/1"
ARTIFACT_MANIFEST = "artifact.json"
FETCHED_MARKER = "fetched.json"
ARTIFACTS_DIRNAME = "artifacts"
ARTIFACT_DIR_ENV = "BENCH_ARTIFACT_DIR"
DOCS_DIRNAME = "docs"
QUERIES_DIRNAME = "queries"
DOCUMENTS_FILENAME = "documents.jsonl.gz"
QUERIES_FILENAME = "queries.jsonl.gz"
QRELS_FILENAME = "qrels.tsv"
DOWNLOAD_CHUNK_BYTES = 1 << 20
DOWNLOAD_TIMEOUT_SECONDS = 120.0
REQUEST_HEADERS = {"User-Agent": "narsil-benchmark-harness"}


class ArtifactError(RuntimeError):
    pass


@dataclass(frozen=True)
class ArtifactFile:
    path: str
    asset: str
    sha256: str
    bytes: int


def dataset_slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def asset_name(path: str) -> str:
    return path.replace("/", ".")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(DOWNLOAD_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact_dir(cache_dir: Path, dataset_id: str) -> Path:
    return Path(cache_dir) / ARTIFACTS_DIRNAME / dataset_slug(dataset_id)


def truth_filename(k: int) -> str:
    return f"truth_k{k}.npz"


def read_manifest(directory: Path) -> dict | None:
    path = Path(directory) / ARTIFACT_MANIFEST
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("format") == ARTIFACT_FORMAT else None


def manifest_files(manifest: dict) -> list[ArtifactFile]:
    files = []
    for entry in manifest.get("files") or []:
        path = str(entry.get("path") or "")
        if not path or path.startswith("/") or ".." in Path(path).parts:
            raise ArtifactError(f"artifact manifest lists an unsafe path {path!r}")
        asset = str(entry.get("asset") or asset_name(path))
        if "/" in asset or asset in (".", ".."):
            raise ArtifactError(f"artifact manifest lists an unsafe asset name {asset!r}")
        files.append(
            ArtifactFile(path=path, asset=asset, sha256=str(entry.get("sha256") or ""), bytes=int(entry.get("bytes") or 0))
        )
    return files


def write_manifest(directory: Path, dataset_id: str, body: Mapping[str, object]) -> str:
    directory = Path(directory)
    files = []
    for path in sorted(p for p in directory.rglob("*") if p.is_file() and p.name not in (ARTIFACT_MANIFEST, FETCHED_MARKER)):
        relative = path.relative_to(directory).as_posix()
        files.append({"path": relative, "asset": asset_name(relative), "sha256": sha256_of(path), "bytes": path.stat().st_size})
    manifest = {"format": ARTIFACT_FORMAT, "dataset_id": dataset_id, **dict(body), "files": files}
    target = directory / ARTIFACT_MANIFEST
    target.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return sha256_of(target)


def _sizes_match(directory: Path, files: list[ArtifactFile]) -> bool:
    for entry in files:
        path = directory / entry.path
        if not path.is_file() or path.stat().st_size != entry.bytes:
            return False
    return True


def is_fetched(directory: Path, expected_sha256: str) -> bool:
    directory = Path(directory)
    marker = directory / FETCHED_MARKER
    manifest_path = directory / ARTIFACT_MANIFEST
    if not marker.is_file() or not manifest_path.is_file():
        return False
    try:
        recorded = json.loads(marker.read_text(encoding="utf-8")).get("manifest_sha256")
    except (OSError, ValueError, AttributeError):
        return False
    if recorded != expected_sha256 or sha256_of(manifest_path) != expected_sha256:
        return False
    manifest = read_manifest(directory)
    return manifest is not None and _sizes_match(directory, manifest_files(manifest))


def download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    with httpx.stream("GET", url, headers=REQUEST_HEADERS, follow_redirects=True, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
        response.raise_for_status()
        with open(partial, "wb") as handle:
            for chunk in response.iter_bytes(DOWNLOAD_CHUNK_BYTES):
                handle.write(chunk)
    os.replace(partial, destination)


def read_remote(url: str) -> bytes:
    response = httpx.get(url, headers=REQUEST_HEADERS, follow_redirects=True, timeout=DOWNLOAD_TIMEOUT_SECONDS)
    response.raise_for_status()
    return response.content


def manifest_url(base_url: str) -> str:
    return f"{base_url}/{ARTIFACT_MANIFEST}"


def _copy_local(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    shutil.copyfile(source, partial)
    os.replace(partial, destination)


def _local_source(environ: Mapping[str, str], dataset_id: str) -> Path | None:
    root = (environ.get(ARTIFACT_DIR_ENV) or "").strip()
    if not root:
        return None
    candidate = Path(root) / dataset_slug(dataset_id)
    return candidate if (candidate / ARTIFACT_MANIFEST).is_file() else None


def _obtain(local: Path | None, base_url: str, relative: str, asset: str, destination: Path) -> None:
    if local is not None:
        _copy_local(local / relative, destination)
    else:
        download_file(f"{base_url}/{asset}", destination)


def fetch_artifact(spec: DatasetSpec, cache_dir: Path, environ: Mapping[str, str] = os.environ) -> Path:
    if spec.artifact is None:
        raise ArtifactError(f"dataset '{spec.dataset_id}' declares no artifact")
    target = artifact_dir(cache_dir, spec.dataset_id)
    if is_fetched(target, spec.artifact.sha256):
        return target
    local = _local_source(environ, spec.dataset_id)
    origin = str(local) if local is not None else spec.artifact.url
    print(f"fetching dataset artifact for {spec.dataset_id} from {origin}", flush=True)
    target.mkdir(parents=True, exist_ok=True)
    _obtain(local, spec.artifact.url, ARTIFACT_MANIFEST, ARTIFACT_MANIFEST, target / ARTIFACT_MANIFEST)
    actual = sha256_of(target / ARTIFACT_MANIFEST)
    if actual != spec.artifact.sha256:
        raise ArtifactError(
            f"artifact manifest for {spec.dataset_id} has sha256 {actual}, config expects {spec.artifact.sha256}"
        )
    manifest = read_manifest(target)
    if manifest is None or manifest.get("dataset_id") != spec.dataset_id:
        raise ArtifactError(f"artifact manifest for {spec.dataset_id} is not a {ARTIFACT_FORMAT} manifest for that dataset")
    for entry in manifest_files(manifest):
        destination = target / entry.path
        if destination.is_file() and destination.stat().st_size == entry.bytes and sha256_of(destination) == entry.sha256:
            continue
        _obtain(local, spec.artifact.url, entry.path, entry.asset, destination)
        digest = sha256_of(destination)
        if digest != entry.sha256:
            destination.unlink(missing_ok=True)
            raise ArtifactError(f"artifact file {entry.path} for {spec.dataset_id} has sha256 {digest}, manifest lists {entry.sha256}")
    (target / FETCHED_MARKER).write_text(json.dumps({"manifest_sha256": actual}), encoding="utf-8")
    return target
