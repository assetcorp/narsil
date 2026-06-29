from __future__ import annotations

from ..core.config import BM25Params, EngineConfig
from ..core.types import BEST_CONFIG, EQUAL_PRECISION, SearchResponse, VectorIndexParams
from ._lucene import _VECTOR_FIELD, LuceneRestDriver, _raise

_RANK_CONSTANT = 60
_PIPELINE = "hybrid-rrf"


class OpenSearchDriver(LuceneRestDriver):
    def __init__(self, engine: EngineConfig, bm25: BM25Params) -> None:
        super().__init__(engine, bm25)
        self.keyword_setup = (
            f"BM25 k1={bm25.k1} b={bm25.b} (custom default similarity, native Lucene "
            f"BM25Similarity in 3.x); OpenSearch `{self._analyzer}` analyzer "
            "(Porter stemmer, English stop words)"
        )
        self.vector_setup = (
            "knn_vector HNSW (faiss engine, inner product on L2-normalized vectors = cosine), "
            "over the shared precomputed vectors"
        )
        self.hybrid_setup = "BM25 match fused with knn via a hybrid query and an RRF search pipeline"
        self.hybrid_fusion = f"score-ranker-processor RRF (rank_constant={_RANK_CONSTANT})"
        self.vector_knob = "ef_search"
        self._vector_profile = EQUAL_PRECISION
        self._pipeline_ready = False

    def _ensure_pipeline(self) -> None:
        if self._pipeline_ready:
            return
        body = {
            "description": "Reciprocal rank fusion for hybrid keyword + vector search",
            "phase_results_processors": [
                {"score-ranker-processor": {"combination": {"technique": "rrf", "rank_constant": _RANK_CONSTANT}}}
            ],
        }
        response = self._client.put(f"/_search/pipeline/{_PIPELINE}", json=body)
        _raise(response)
        self._pipeline_ready = True

    def create_vector_index(self, index: str, params: VectorIndexParams) -> None:
        self._vector_profile = params.profile
        method_parameters: dict = {"m": params.m, "ef_construction": params.ef_construction}
        if params.profile == BEST_CONFIG:
            method_parameters["encoder"] = {"name": "sq", "parameters": {"bits": 16}}
            self.vector_setup = (
                "knn_vector HNSW (faiss engine, 16-bit SQ / SQfp16 scalar quantization, inner product on "
                "L2-normalized vectors = cosine), over the shared precomputed vectors"
            )
            self.hybrid_setup = "BM25 match fused with SQfp16-quantized knn via a hybrid query and an RRF search pipeline"
        body = {
            "settings": {
                "index": {
                    "number_of_shards": 1,
                    "number_of_replicas": 0,
                    "knn": True,
                    "similarity": {"default": {"type": "BM25", "k1": self._k1, "b": self._b}},
                }
            },
            "mappings": {
                "properties": {
                    "text": {"type": "text", "analyzer": self._analyzer},
                    _VECTOR_FIELD: {
                        "type": "knn_vector",
                        "dimension": params.dims,
                        "space_type": "innerproduct",
                        "method": {
                            "name": "hnsw",
                            "engine": "faiss",
                            "parameters": method_parameters,
                        },
                    },
                }
            },
        }
        response = self._client.put(f"/{index}", json=body)
        _raise(response)

    def _knn(self, vector: list[float], limit: int, ef: int | None) -> dict:
        ef_search = max(ef if ef is not None else limit, limit)
        return {_VECTOR_FIELD: {"vector": vector, "k": limit, "method_parameters": {"ef_search": ef_search}}}

    def vector_search(self, index: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        body = {"query": {"knn": self._knn(vector, limit, ef)}, "size": limit, "_source": False}
        return self._post_search(index, body)

    def hybrid_search(self, index: str, term: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        self._ensure_pipeline()
        body = {
            "query": {
                "hybrid": {
                    "pagination_depth": limit,
                    "queries": [
                        {"match": {"text": {"query": term}}},
                        {"knn": self._knn(vector, limit, ef)},
                    ],
                }
            },
            "size": limit,
            "_source": False,
        }
        return self._post_search(index, body, params={"search_pipeline": _PIPELINE})
