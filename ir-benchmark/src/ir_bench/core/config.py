from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class BM25Params:
    k1: float
    b: float


@dataclass(frozen=True)
class LatencyConfig:
    warmup: int
    repeats: int
    top_k: int


@dataclass(frozen=True)
class DatasetSpec:
    dataset_id: str
    baseline_ndcg10: float | None
    margin: float
    baseline_source: str


@dataclass(frozen=True)
class EngineConfig:
    name: str
    url: str
    run_tag: str
    ranking: str
    analyzer: str | None
    language: str | None


@dataclass(frozen=True)
class BenchmarkConfig:
    bm25: BM25Params
    run_depth: int
    import_batch: int
    memory_cap_bytes: int | None
    latency: LatencyConfig
    datasets: tuple[DatasetSpec, ...]
    engines: dict[str, EngineConfig]


def _require(table: dict, key: str, where: str):
    if key not in table:
        raise ValueError(f"missing required key '{key}' in {where}")
    return table[key]


def _load_engines(raw: dict) -> dict[str, EngineConfig]:
    engines_raw = raw.get("engines")
    if not engines_raw or not isinstance(engines_raw, dict):
        raise ValueError("at least one [engines.<name>] section is required")
    engines: dict[str, EngineConfig] = {}
    for name, entry in engines_raw.items():
        url = str(_require(entry, "url", f"[engines.{name}]")).rstrip("/")
        ranking = str(entry.get("ranking", "bm25"))
        if ranking not in ("bm25", "native"):
            raise ValueError(f"[engines.{name}].ranking must be 'bm25' or 'native'")
        engines[name] = EngineConfig(
            name=name,
            url=url,
            run_tag=str(entry.get("run_tag", f"{name}")),
            ranking=ranking,
            analyzer=entry.get("analyzer"),
            language=entry.get("language"),
        )
    return engines


def load_config(path: Path) -> BenchmarkConfig:
    raw = tomllib.loads(Path(path).read_text(encoding="utf-8"))

    bm25_raw = _require(raw, "bm25", "config")
    bm25 = BM25Params(k1=float(_require(bm25_raw, "k1", "[bm25]")), b=float(_require(bm25_raw, "b", "[bm25]")))

    retrieval = raw.get("retrieval", {})
    run_depth = int(retrieval.get("run_depth", 1000))
    import_batch = int(retrieval.get("import_batch", 2000))
    if run_depth < 100:
        raise ValueError("retrieval.run_depth must be at least 100 to compute Recall@100")
    if import_batch < 1:
        raise ValueError("retrieval.import_batch must be positive")

    fairness = raw.get("fairness", {})
    cap_raw = fairness.get("memory_cap_bytes")
    memory_cap_bytes = None if cap_raw is None else int(cap_raw)

    lat_raw = raw.get("latency", {})
    latency = LatencyConfig(
        warmup=int(lat_raw.get("warmup", 2)),
        repeats=int(lat_raw.get("repeats", 5)),
        top_k=int(lat_raw.get("top_k", 10)),
    )
    if latency.repeats < 1:
        raise ValueError("latency.repeats must be positive")

    datasets_raw = raw.get("datasets")
    if not datasets_raw:
        raise ValueError("at least one [[datasets]] entry is required")
    datasets: list[DatasetSpec] = []
    for entry in datasets_raw:
        dataset_id = _require(entry, "id", "[[datasets]]")
        baseline = entry.get("baseline_ndcg10")
        datasets.append(
            DatasetSpec(
                dataset_id=str(dataset_id),
                baseline_ndcg10=None if baseline is None else float(baseline),
                margin=float(entry.get("margin", 0.02)),
                baseline_source=str(entry.get("baseline_source", "")),
            )
        )

    return BenchmarkConfig(
        bm25=bm25,
        run_depth=run_depth,
        import_batch=import_batch,
        memory_cap_bytes=memory_cap_bytes,
        latency=latency,
        datasets=tuple(datasets),
        engines=_load_engines(raw),
    )


def select_engine(config: BenchmarkConfig, name: str | None) -> EngineConfig:
    chosen = name or os.environ.get("ENGINE") or "narsil"
    if chosen not in config.engines:
        available = ", ".join(sorted(config.engines))
        raise SystemExit(f"unknown engine '{chosen}'; configured engines: {available}")
    engine = config.engines[chosen]
    url_override = os.environ.get("ENGINE_URL")
    if url_override:
        engine = EngineConfig(
            name=engine.name,
            url=url_override.rstrip("/"),
            run_tag=engine.run_tag,
            ranking=engine.ranking,
            analyzer=engine.analyzer,
            language=engine.language,
        )
    return engine
