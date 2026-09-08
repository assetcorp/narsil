from __future__ import annotations

import hashlib
import json
import os
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

import httpx

from .config_datasets import DatasetSpec

ARTIFACT_FORMAT = "narsil-benchmark-dataset/1"
ARTIFACT_MANIFEST = "artifact.json"
FETCHED_MARKER = "fetched.json"
LOCAL_MARKER = "local.json"
ARTIFACTS_DIRNAME = "artifacts"
ARTIFACT_DIR_ENV = "BENCH_ARTIFACT_DIR"
DOCS_DIRNAME = "docs"
QUERIES_DIRNAME = "queries"
DOCUMENTS_FILENAME = "documents.jsonl.gz"
QUERIES_FILENAME = "queries.jsonl.gz"
QRELS_FILENAME = "qrels.tsv"
DOWNLOAD_CHUNK_BYTES = 1 << 20
DOWNLOAD_TIMEOUT_SECONDS = 120.0
DOWNLOAD_ATTEMPTS = 10
DOWNLOAD_RETRY_DELAY_SECONDS = 5.0
RETRIABLE_STATUSES = (408, 425, 429, 500, 502, 503, 504)
PARTIAL_CONTENT = 206
RANGE_NOT_SATISFIABLE = 416
REQUEST_HEADERS = {"User-Agent": "narsil-benchmark-harness"}
PARTIAL_SUFFIX = ".part"


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


def http_client(transport: httpx.BaseTransport | None = None) -> httpx.Client:
    return httpx.Client(
        headers=REQUEST_HEADERS, follow_redirects=True, timeout=DOWNLOAD_TIMEOUT_SECONDS, transport=transport
    )


def _retriable(error: Exception) -> bool:
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code in RETRIABLE_STATUSES
    return isinstance(error, (httpx.HTTPError, OSError))


def with_retries(action: Callable[[], object], label: str, attempts: int, sleep: Callable[[float], None]):
    for attempt in range(1, attempts + 1):
        try:
            return action()
        except Exception as error:
            if attempt == attempts or not _retriable(error):
                raise
            delay = DOWNLOAD_RETRY_DELAY_SECONDS * attempt
            print(f"  {label} failed on attempt {attempt} of {attempts} ({error}); retrying in {delay:g}s", flush=True)
            sleep(delay)
    raise AssertionError("unreachable")


def _resume_download(client: httpx.Client, url: str, partial: Path) -> None:
    offset = partial.stat().st_size if partial.exists() else 0
    headers = {"Range": f"bytes={offset}-"} if offset else {}
    with client.stream("GET", url, headers=headers) as response:
        if response.status_code == RANGE_NOT_SATISFIABLE:
            partial.unlink(missing_ok=True)
            raise httpx.TransportError(f"the server refused to resume {url} at byte {offset}; starting over")
        response.raise_for_status()
        resumed = offset > 0 and response.status_code == PARTIAL_CONTENT
        with open(partial, "ab" if resumed else "wb") as handle:
            for chunk in response.iter_bytes(DOWNLOAD_CHUNK_BYTES):
                handle.write(chunk)


def download_file(
    url: str,
    destination: Path,
    client: httpx.Client | None = None,
    attempts: int = DOWNLOAD_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + PARTIAL_SUFFIX)
    owned = client is None
    session = client if client is not None else http_client()
    try:
        with_retries(lambda: _resume_download(session, url, partial), f"download of {url}", attempts, sleep)
    finally:
        if owned:
            session.close()
    os.replace(partial, destination)


def read_remote(
    url: str,
    client: httpx.Client | None = None,
    attempts: int = DOWNLOAD_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
) -> bytes:
    owned = client is None
    session = client if client is not None else http_client()

    def fetch() -> bytes:
        response = session.get(url)
        response.raise_for_status()
        return response.content

    try:
        return bytes(with_retries(fetch, f"request to {url}", attempts, sleep))
    finally:
        if owned:
            session.close()


def manifest_url(base_url: str) -> str:
    return f"{base_url}/{ARTIFACT_MANIFEST}"


def _local_source(environ: Mapping[str, str], dataset_id: str) -> Path | None:
    root = (environ.get(ARTIFACT_DIR_ENV) or "").strip()
    if not root:
        return None
    candidate = Path(root) / dataset_slug(dataset_id)
    return candidate if (candidate / ARTIFACT_MANIFEST).is_file() else None


def _read_marker(path: Path) -> dict:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _checked_manifest(spec: DatasetSpec, directory: Path) -> dict:
    artifact = spec.artifact
    if artifact is None:
        raise ArtifactError(f"dataset '{spec.dataset_id}' declares no artifact")
    actual = sha256_of(directory / ARTIFACT_MANIFEST)
    if actual != artifact.sha256:
        raise ArtifactError(f"artifact manifest for {spec.dataset_id} has sha256 {actual}, config expects {artifact.sha256}")
    manifest = read_manifest(directory)
    if manifest is None or manifest.get("dataset_id") != spec.dataset_id:
        raise ArtifactError(f"artifact manifest for {spec.dataset_id} is not a {ARTIFACT_FORMAT} manifest for that dataset")
    return manifest


def verified_local_dir(spec: DatasetSpec, cache_dir: Path, environ: Mapping[str, str] = os.environ) -> Path | None:
    """The local copy of an artifact, read in place, once an earlier fetch has
    hashed every file in it against the manifest the config pins. The marker
    stays in the cache directory because the local copy is mounted read-only."""

    local = _local_source(environ, spec.dataset_id)
    if local is None or spec.artifact is None:
        return None
    marker = _read_marker(artifact_dir(cache_dir, spec.dataset_id) / LOCAL_MARKER)
    if marker.get("manifest_sha256") != spec.artifact.sha256 or marker.get("path") != str(local):
        return None
    if sha256_of(local / ARTIFACT_MANIFEST) != spec.artifact.sha256:
        return None
    manifest = read_manifest(local)
    return local if manifest is not None and _sizes_match(local, manifest_files(manifest)) else None


def artifact_location(spec: DatasetSpec, cache_dir: Path, environ: Mapping[str, str] = os.environ) -> Path | None:
    """Where the harness reads a fetched artifact from: the cache directory the
    download filled, or the verified local copy, or nothing until the embed step
    has fetched it."""

    if spec.artifact is None:
        return None
    cached = artifact_dir(cache_dir, spec.dataset_id)
    if is_fetched(cached, spec.artifact.sha256):
        return cached
    return verified_local_dir(spec, cache_dir, environ)


def _verify_local(spec: DatasetSpec, local: Path, cache_dir: Path) -> Path:
    manifest = _checked_manifest(spec, local)
    for entry in manifest_files(manifest):
        path = local / entry.path
        if not path.is_file():
            raise ArtifactError(f"artifact file {entry.path} for {spec.dataset_id} is missing from {local}")
        digest = sha256_of(path)
        if path.stat().st_size != entry.bytes or digest != entry.sha256:
            raise ArtifactError(f"artifact file {entry.path} for {spec.dataset_id} has sha256 {digest}, manifest lists {entry.sha256}")
    cached = artifact_dir(cache_dir, spec.dataset_id)
    cached.mkdir(parents=True, exist_ok=True)
    marker = {"manifest_sha256": sha256_of(local / ARTIFACT_MANIFEST), "path": str(local)}
    (cached / LOCAL_MARKER).write_text(json.dumps(marker), encoding="utf-8")
    return local


def _download_artifact(spec: DatasetSpec, target: Path) -> Path:
    artifact = spec.artifact
    if artifact is None:
        raise ArtifactError(f"dataset '{spec.dataset_id}' declares no artifact")
    target.mkdir(parents=True, exist_ok=True)
    download_file(manifest_url(artifact.url), target / ARTIFACT_MANIFEST)
    manifest = _checked_manifest(spec, target)
    for entry in manifest_files(manifest):
        destination = target / entry.path
        if destination.is_file() and destination.stat().st_size == entry.bytes and sha256_of(destination) == entry.sha256:
            continue
        download_file(f"{artifact.url}/{entry.asset}", destination)
        digest = sha256_of(destination)
        if digest != entry.sha256:
            destination.unlink(missing_ok=True)
            raise ArtifactError(f"artifact file {entry.path} for {spec.dataset_id} has sha256 {digest}, manifest lists {entry.sha256}")
    (target / FETCHED_MARKER).write_text(json.dumps({"manifest_sha256": artifact.sha256}), encoding="utf-8")
    return target


def fetch_artifact(spec: DatasetSpec, cache_dir: Path, environ: Mapping[str, str] = os.environ) -> Path:
    """The directory holding the dataset's verified artifact. A local copy under
    `BENCH_ARTIFACT_DIR` is hashed once and then read where it is, and otherwise
    every file the manifest lists is downloaded into the cache, with any file
    already present and matching its digest left alone."""

    if spec.artifact is None:
        raise ArtifactError(f"dataset '{spec.dataset_id}' declares no artifact")
    located = artifact_location(spec, cache_dir, environ)
    if located is not None:
        return located
    local = _local_source(environ, spec.dataset_id)
    if local is not None:
        print(f"verifying the local dataset artifact for {spec.dataset_id} at {local}", flush=True)
        return _verify_local(spec, local, cache_dir)
    print(f"fetching dataset artifact for {spec.dataset_id} from {spec.artifact.url}", flush=True)
    return _download_artifact(spec, artifact_dir(cache_dir, spec.dataset_id))
