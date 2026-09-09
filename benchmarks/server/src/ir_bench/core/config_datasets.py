from __future__ import annotations

import re
from dataclasses import dataclass

IR_DATASETS_SOURCE = "ir_datasets"
ARTIFACT_SOURCE = "artifact"
DATASET_SOURCES = (IR_DATASETS_SOURCE, ARTIFACT_SOURCE)
DEFAULT_MARGIN = 0.02

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class DatasetArtifact:
    url: str
    sha256: str


@dataclass(frozen=True)
class DatasetSpec:
    dataset_id: str
    baseline_ndcg10: float | None
    margin: float
    baseline_source: str
    large: bool = False
    source: str = IR_DATASETS_SOURCE
    artifact: DatasetArtifact | None = None
    vector_model: str | None = None
    vector_dims: int | None = None


def _require(table: dict, key: str, where: str):
    if key not in table:
        raise ValueError(f"missing required key '{key}' in {where}")
    return table[key]


def _load_artifact(entry: dict, where: str) -> DatasetArtifact | None:
    url = entry.get("artifact_url")
    sha = entry.get("artifact_sha256")
    if url is None and sha is None:
        return None
    if not isinstance(url, str) or not url.strip():
        raise ValueError(f"{where}.artifact_url must be a non-empty string when artifact_sha256 is set")
    if not isinstance(sha, str) or not _SHA256.match(sha.strip().lower()):
        raise ValueError(f"{where}.artifact_sha256 must be a 64-character hex digest")
    return DatasetArtifact(url=url.strip().rstrip("/"), sha256=sha.strip().lower())


def _load_vector_override(entry: dict, where: str) -> tuple[str | None, int | None]:
    model = entry.get("vector_model")
    dims = entry.get("vector_dims")
    if model is None and dims is None:
        return None, None
    if not isinstance(model, str) or not model.strip():
        raise ValueError(f"{where}.vector_model must be a non-empty string when vector_dims is set")
    if not isinstance(dims, int) or isinstance(dims, bool) or dims < 1:
        raise ValueError(f"{where}.vector_dims must be a positive integer when vector_model is set")
    return model.strip(), dims


def load_dataset_spec(entry: dict) -> DatasetSpec:
    dataset_id = str(_require(entry, "id", "[[datasets]]"))
    where = f"[[datasets]] '{dataset_id}'"
    source = str(entry.get("source", IR_DATASETS_SOURCE))
    if source not in DATASET_SOURCES:
        raise ValueError(f"{where}.source must be one of {', '.join(DATASET_SOURCES)}")
    artifact = _load_artifact(entry, where)
    model, dims = _load_vector_override(entry, where)
    if source == ARTIFACT_SOURCE:
        if artifact is None:
            raise ValueError(f"{where} has source 'artifact' and needs artifact_url and artifact_sha256")
        if model is None:
            raise ValueError(f"{where} has source 'artifact' and needs vector_model and vector_dims")
    baseline = entry.get("baseline_ndcg10")
    return DatasetSpec(
        dataset_id=dataset_id,
        baseline_ndcg10=None if baseline is None else float(baseline),
        margin=float(entry.get("margin", DEFAULT_MARGIN)),
        baseline_source=str(entry.get("baseline_source", "")),
        large=bool(entry.get("large", False)),
        source=source,
        artifact=artifact,
        vector_model=model,
        vector_dims=dims,
    )


def load_datasets(raw: dict) -> tuple[DatasetSpec, ...]:
    entries = raw.get("datasets")
    if not entries:
        raise ValueError("at least one [[datasets]] entry is required")
    specs = tuple(load_dataset_spec(entry) for entry in entries)
    seen: set[str] = set()
    for spec in specs:
        if spec.dataset_id in seen:
            raise ValueError(f"[[datasets]] lists '{spec.dataset_id}' more than once")
        seen.add(spec.dataset_id)
    return specs
