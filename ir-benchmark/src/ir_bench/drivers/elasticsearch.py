from __future__ import annotations

from ..core.config import BM25Params, EngineConfig
from ..core.types import SearchResponse, VectorIndexParams
from ._lucene import _VECTOR_FIELD, LuceneRestDriver, _raise

_RANK_CONSTANT = 60


class ElasticsearchDriver(LuceneRestDriver):
    def __init__(self, engine: EngineConfig, bm25: BM25Params) -> None:
        super().__init__(engine, bm25)
        self.keyword_setup = (
            f"BM25 k1={bm25.k1} b={bm25.b} (custom default similarity); "
            f"Elasticsearch `{self._analyzer}` analyzer (Porter stemmer, English stop words)"
        )
        self.vector_setup = "dense_vector HNSW, similarity cosine, over the shared precomputed vectors"
        self.hybrid_setup = "BM25 match fused with dense_vector kNN via the RRF retriever"
        self.hybrid_fusion = f"RRF retriever (rank_constant={_RANK_CONSTANT})"
        self.vector_knob = "num_candidates"

    def create_vector_index(self, index: str, params: VectorIndexParams) -> None:
        body = {
            "settings": {
                "index": {
                    "number_of_shards": 1,
                    "number_of_replicas": 0,
                    "similarity": {"default": {"type": "BM25", "k1": self._k1, "b": self._b}},
                }
            },
            "mappings": {
                "properties": {
                    "text": {"type": "text", "analyzer": self._analyzer},
                    _VECTOR_FIELD: {
                        "type": "dense_vector",
                        "dims": params.dims,
                        "index": True,
                        "similarity": "cosine",
                        "index_options": {
                            "type": "hnsw",
                            "m": params.m,
                            "ef_construction": params.ef_construction,
                        },
                    },
                }
            },
        }
        response = self._client.put(f"/{index}", json=body)
        _raise(response)

    def _knn(self, vector: list[float], limit: int, ef: int | None) -> dict:
        candidates = max(ef if ef is not None else limit, limit)
        return {"field": _VECTOR_FIELD, "query_vector": vector, "k": limit, "num_candidates": candidates}

    def vector_search(self, index: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        body = {"retriever": {"knn": self._knn(vector, limit, ef)}, "size": limit, "_source": False}
        return self._post_search(index, body)

    def hybrid_search(self, index: str, term: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        body = {
            "retriever": {
                "rrf": {
                    "retrievers": [
                        {"standard": {"query": {"match": {"text": term}}}},
                        {"knn": self._knn(vector, limit, ef)},
                    ],
                    "rank_constant": _RANK_CONSTANT,
                    "rank_window_size": max(limit, _RANK_CONSTANT),
                }
            },
            "size": limit,
            "_source": False,
        }
        return self._post_search(index, body)
