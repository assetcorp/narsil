from __future__ import annotations

from .config import BM25Params, EngineConfig
from .driver import EngineDriver


def build_driver(engine: EngineConfig, bm25: BM25Params) -> EngineDriver:
    from ..drivers.elasticsearch import ElasticsearchDriver
    from ..drivers.meilisearch import MeilisearchDriver
    from ..drivers.narsil import NarsilDriver
    from ..drivers.opensearch import OpenSearchDriver
    from ..drivers.typesense import TypesenseDriver

    factories = {
        "narsil": NarsilDriver,
        "elasticsearch": ElasticsearchDriver,
        "opensearch": OpenSearchDriver,
        "typesense": TypesenseDriver,
        "meilisearch": MeilisearchDriver,
    }
    factory = factories.get(engine.name)
    if factory is None:
        available = ", ".join(sorted(factories))
        raise SystemExit(f"no driver registered for engine '{engine.name}'; available: {available}")
    return factory(engine, bm25)
