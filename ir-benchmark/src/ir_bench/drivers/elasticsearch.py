from __future__ import annotations

from ..core.config import BM25Params, EngineConfig
from ._lucene import LuceneRestDriver


class ElasticsearchDriver(LuceneRestDriver):
    def __init__(self, engine: EngineConfig, bm25: BM25Params) -> None:
        super().__init__(engine, bm25)
        self.keyword_setup = (
            f"BM25 k1={bm25.k1} b={bm25.b} (custom default similarity); "
            f"Elasticsearch `{self._analyzer}` analyzer (Porter stemmer, English stop words)"
        )
