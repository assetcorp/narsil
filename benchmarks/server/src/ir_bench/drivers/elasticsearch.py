from __future__ import annotations

from ..core.config import BM25Params, EngineConfig
from ..core.types import BEST_CONFIG, EQUAL_PRECISION, SearchResponse, VectorIndexParams
from ._lucene import _VECTOR_FIELD, LuceneRestDriver, _raise

_RANK_CONSTANT = 60
_BBQ_OVERSAMPLE = 3.0
# Elasticsearch caps rescore_vector.oversample below 10.0, so the recall-tuning sweep
# starts at the recommended 3x and escalates within that bound. BBQ's recall lever is
# this oversample (the full-precision rescore pool = k * oversample), not num_candidates.
_BBQ_OVERSAMPLE_GRID = (3.0, 5.0, 8.0, 9.0)


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
        self._vector_profile = EQUAL_PRECISION
        self.rescore_oversample_grid = _BBQ_OVERSAMPLE_GRID
        self._rescore_oversample: float | None = None

    def set_rescore_oversample(self, value: float | None) -> None:
        self._rescore_oversample = value

    def create_vector_index(self, index: str, params: VectorIndexParams) -> None:
        self._vector_profile = params.profile
        # Elasticsearch quantizes float dense_vectors by default (int8_hnsw since 8.14,
        # bbq_hnsw for >= 384 dims since 9.1), so equal-precision must force `hnsw`
        # explicitly to compare full float against the other engines. Best-config uses
        # BBQ, Elastic's own recommended default at this dimensionality.
        if params.profile == BEST_CONFIG:
            index_type = "bbq_hnsw"
            self.vector_setup = (
                "dense_vector BBQ (bbq_hnsw, binary quantization) with full-precision "
                "rescore (oversample tuned to the recall target), similarity cosine"
            )
            self.hybrid_setup = "BM25 match fused with BBQ dense_vector kNN (full-precision rescore) via the RRF retriever"
        else:
            index_type = "hnsw"
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
                            "type": index_type,
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
        knn = {"field": _VECTOR_FIELD, "query_vector": vector, "k": limit, "num_candidates": candidates}
        if self._vector_profile == BEST_CONFIG:
            oversample = self._rescore_oversample if self._rescore_oversample is not None else _BBQ_OVERSAMPLE
            knn["rescore_vector"] = {"oversample": oversample}
        return knn

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
