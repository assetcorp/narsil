from __future__ import annotations

from collections.abc import Iterable

from .config_datasets import DatasetSpec

DATASET_ENGINES_ENV = "BENCH_DATASET_ENGINES"
ASSIGNMENT_SEPARATOR = ";"
ENGINE_SEPARATOR = ","


class DatasetEnginesError(ValueError):
    pass


def parse_dataset_engines(
    raw: str | None, dataset_ids: Iterable[str], engine_names: Iterable[str]
) -> dict[str, tuple[str, ...]]:
    text = (raw or "").strip()
    if not text:
        return {}
    known_datasets = set(dataset_ids)
    known_engines = set(engine_names)
    mapping: dict[str, tuple[str, ...]] = {}
    for assignment in text.split(ASSIGNMENT_SEPARATOR):
        assignment = assignment.strip()
        if not assignment:
            continue
        dataset_id, separator, engines_text = assignment.partition("=")
        dataset_id = dataset_id.strip()
        if not separator or not dataset_id:
            raise DatasetEnginesError(
                f"{DATASET_ENGINES_ENV} entry {assignment!r} is not of the form <dataset id>=<engine>,<engine>"
            )
        if dataset_id not in known_datasets:
            raise DatasetEnginesError(f"{DATASET_ENGINES_ENV} names an unknown dataset {dataset_id!r}")
        if dataset_id in mapping:
            raise DatasetEnginesError(f"{DATASET_ENGINES_ENV} names {dataset_id!r} twice")
        engines = tuple(name.strip() for name in engines_text.split(ENGINE_SEPARATOR) if name.strip())
        if not engines:
            raise DatasetEnginesError(f"{DATASET_ENGINES_ENV} lists no engine for {dataset_id!r}")
        unknown = [name for name in engines if name not in known_engines]
        if unknown:
            raise DatasetEnginesError(f"{DATASET_ENGINES_ENV} names unknown engines {unknown} for {dataset_id!r}")
        mapping[dataset_id] = engines
    return mapping


def datasets_for_engine(
    specs: Iterable[DatasetSpec], engine_name: str, mapping: dict[str, tuple[str, ...]]
) -> tuple[DatasetSpec, ...]:
    selected = []
    for spec in specs:
        engines = mapping.get(spec.dataset_id)
        if engines is None or engine_name in engines:
            selected.append(spec)
    return tuple(selected)
