from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from .types import KEYWORD, TRACKS


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
    large: bool = False


@dataclass(frozen=True)
class EngineConfig:
    name: str
    url: str
    run_tag: str
    ranking: str
    analyzer: str | None
    language: str | None
    tracks: tuple[str, ...]


@dataclass(frozen=True)
class VectorConfig:
    """Settings shared by the vector and hybrid tracks. The dense vectors come
    from one model run once and fed identically to every engine, so the metric,
    dimension, and build-time HNSW parameters are fixed here for all of them."""

    model: str
    sparse_model: str
    dims: int
    metric: str
    hnsw_m: int
    hnsw_ef_construction: int
    ef_search_grid: tuple[int, ...]
    recall_target: float
    recall_target_secondary: float
    recall_k: int
    query_prefix: str
    passage_prefix: str


@dataclass(frozen=True)
class BenchmarkConfig:
    bm25: BM25Params
    run_depth: int
    import_batch: int
    memory_cap_bytes: int | None
    latency: LatencyConfig
    datasets: tuple[DatasetSpec, ...]
    engines: dict[str, EngineConfig]
    vector: VectorConfig | None


def _require(table: dict, key: str, where: str):
    if key not in table:
        raise ValueError(f"missing required key '{key}' in {where}")
    return table[key]


def parse_size(value: str) -> int:
    """Parse a Docker-style size such as '8g', '40gb', or a raw byte count into
    bytes, using binary units to match how Docker interprets mem_limit."""

    text = value.strip().lower()
    if not text:
        raise ValueError("empty size value")
    if text.endswith("b"):
        text = text[:-1]
    if text.endswith("i"):
        text = text[:-1]
    units = {"k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4}
    multiplier = 1
    if text and text[-1] in units:
        multiplier = units[text[-1]]
        text = text[:-1]
    return int(float(text) * multiplier)


def _load_tracks(name: str, entry: dict) -> tuple[str, ...]:
    raw = entry.get("tracks", [KEYWORD])
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"[engines.{name}].tracks must be a non-empty array")
    tracks: list[str] = []
    for track in raw:
        if track not in TRACKS:
            raise ValueError(f"[engines.{name}].tracks has unknown track '{track}'; allowed: {', '.join(TRACKS)}")
        if track not in tracks:
            tracks.append(str(track))
    return tuple(tracks)


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
            tracks=_load_tracks(name, entry),
        )
    return engines


def _load_vector(raw: dict) -> VectorConfig | None:
    vec = raw.get("vector")
    if not vec:
        return None
    metric = str(vec.get("metric", "cosine"))
    grid_raw = vec.get("ef_search_grid", [16, 32, 64, 128, 256, 512])
    if not isinstance(grid_raw, list) or not grid_raw:
        raise ValueError("[vector].ef_search_grid must be a non-empty array of integers")
    grid = tuple(sorted({int(value) for value in grid_raw}))
    if any(value < 1 for value in grid):
        raise ValueError("[vector].ef_search_grid values must be positive")
    recall_k = int(vec.get("recall_k", 10))
    if recall_k < 1:
        raise ValueError("[vector].recall_k must be positive")
    return VectorConfig(
        model=str(_require(vec, "model", "[vector]")),
        sparse_model=str(vec.get("sparse_model", "Qdrant/bm25")),
        dims=int(_require(vec, "dims", "[vector]")),
        metric=metric,
        hnsw_m=int(vec.get("hnsw_m", 16)),
        hnsw_ef_construction=int(vec.get("hnsw_ef_construction", 200)),
        ef_search_grid=grid,
        recall_target=float(vec.get("recall_target", 0.99)),
        recall_target_secondary=float(vec.get("recall_target_secondary", 0.95)),
        recall_k=recall_k,
        query_prefix=str(vec.get("query_prefix", "")),
        passage_prefix=str(vec.get("passage_prefix", "")),
    )


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
    env_cap = os.environ.get("BENCH_MEM_CAP")
    if env_cap and env_cap.strip():
        memory_cap_bytes = parse_size(env_cap)

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
                large=bool(entry.get("large", False)),
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
        vector=_load_vector(raw),
    )


def select_datasets(config: BenchmarkConfig, only: str | None) -> tuple[DatasetSpec, ...]:
    """Resolve which datasets a run touches. A comma-separated selection matches
    configured ids exactly and may include large datasets. With no selection the
    default set is every dataset not flagged `large`, so the small BEIR suite runs
    on a laptop while million-passage corpora stay opt-in for a sized machine."""

    if only and only.strip():
        wanted = {name.strip() for name in only.split(",") if name.strip()}
        selected = tuple(spec for spec in config.datasets if spec.dataset_id in wanted)
        if not selected:
            raise SystemExit(f"no configured datasets matched: {sorted(wanted)}")
        return selected
    return tuple(spec for spec in config.datasets if not spec.large)


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
            tracks=engine.tracks,
        )
    return engine
