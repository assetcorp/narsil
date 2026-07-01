from __future__ import annotations

from .config import BM25Params, EngineConfig


def build_driver(engine: EngineConfig, bm25: BM25Params):
    from ..drivers.elasticsearch import ElasticsearchDriver
    from ..drivers.meilisearch import MeilisearchDriver
    from ..drivers.narsil import NarsilDriver
    from ..drivers.opensearch import OpenSearchDriver
    from ..drivers.qdrant import QdrantDriver
    from ..drivers.typesense import TypesenseDriver
    from ..drivers.weaviate import WeaviateDriver

    factories = {
        "narsil": NarsilDriver,
        "elasticsearch": ElasticsearchDriver,
        "opensearch": OpenSearchDriver,
        "typesense": TypesenseDriver,
        "meilisearch": MeilisearchDriver,
        "qdrant": QdrantDriver,
        "weaviate": WeaviateDriver,
    }
    factory = factories.get(engine.name)
    if factory is None:
        available = ", ".join(sorted(factories))
        raise SystemExit(f"no driver registered for engine '{engine.name}'; available: {available}")
    return factory(engine, bm25)
