from __future__ import annotations

from ..core.config import BM25Params, EngineConfig
from ..core.types import BEST_CONFIG, EQUAL_PRECISION, FULL_FLOAT, SearchResponse, VectorIndexParams
from ._lucene import _VECTOR_FIELD, LuceneRestDriver, _raise

_RANK_CONSTANT = 60
_PIPELINE = "hybrid-rrf"
_BINARY_QUANTIZATION_MIN_DIMENSIONS = 1536
_BINARY_RESCORE_OVERSAMPLE = 2.0


class OpenSearchDriver(LuceneRestDriver):
    def __init__(self, engine: EngineConfig, bm25: BM25Params) -> None:
        super().__init__(engine, bm25)
        self.keyword_setup = (
            f"BM25 k1={bm25.k1} b={bm25.b} (custom default similarity); "
            f"OpenSearch `{self._analyzer}` analyzer"
        )
        self.vector_setup = (
            "knn_vector HNSW (faiss engine, inner product on L2-normalized vectors = cosine), "
            "over the shared precomputed vectors"
        )
        self.hybrid_setup = "BM25 match fused with knn via a hybrid query and an RRF search pipeline"
        self.hybrid_fusion = f"score-ranker-processor RRF (rank_constant={_RANK_CONSTANT})"
        self.vector_knob = "ef_search"
        self.vector_quantization = FULL_FLOAT
        self._vector_profile = EQUAL_PRECISION
        self._pipeline_ready = False
        self._binary_indexes: dict[str, bool] = {}

    def set_vector_profile(self, profile: str) -> None:
        """Adopts a profile the driver did not itself create the index under, so a
        load-generator process searching an index another process built asks for the
        same precision the run tuned to."""

        self._vector_profile = profile

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
        binary = params.profile == BEST_CONFIG and params.dims >= _BINARY_QUANTIZATION_MIN_DIMENSIONS
        self._binary_indexes[index] = binary
        if binary:
            method_parameters["encoder"] = {"name": "binary", "parameters": {"bits": 1}}
            self.vector_quantization = "1-bit binary"
            self.vector_setup = (
                "knn_vector HNSW (faiss engine, 1-bit binary quantization with full-precision rescore at "
                f"oversample {_BINARY_RESCORE_OVERSAMPLE}, inner product on L2-normalized vectors = cosine), "
                "over the shared precomputed vectors; 1-bit is used from "
                f"{_BINARY_QUANTIZATION_MIN_DIMENSIONS} dimensions because it cannot reach the recall target "
                "on 384-dimension vectors"
            )
            self.hybrid_setup = (
                "BM25 match fused with 1-bit binary-quantized knn via a hybrid query and an RRF search pipeline"
            )
        elif params.profile == BEST_CONFIG:
            method_parameters["encoder"] = {"name": "sq", "parameters": {"bits": 16}}
            self.vector_quantization = "SQfp16"
            self.vector_setup = (
                "knn_vector HNSW (faiss engine, 16-bit SQ / SQfp16 scalar quantization, inner product on "
                "L2-normalized vectors = cosine), over the shared precomputed vectors; 1-bit binary "
                "quantization cannot reach the recall target at this dimensionality"
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

    def _uses_binary_quantization(self, index: str) -> bool:
        if self._vector_profile != BEST_CONFIG:
            return False
        known = self._binary_indexes.get(index)
        if known is not None:
            return known
        response = self._client.get(f"/{index}/_mapping")
        _raise(response)
        mapping = response.json().get(index, {}).get("mappings", {}).get("properties", {}).get(_VECTOR_FIELD, {})
        encoder = mapping.get("method", {}).get("parameters", {}).get("encoder", {})
        binary = encoder.get("name") == "binary"
        self._binary_indexes[index] = binary
        return binary

    def _knn(self, index: str, vector: list[float], limit: int, ef: int | None) -> dict:
        ef_search = max(ef if ef is not None else limit, limit)
        clause: dict = {"vector": vector, "k": limit, "method_parameters": {"ef_search": ef_search}}
        if self._uses_binary_quantization(index):
            clause["rescore"] = {"oversample_factor": _BINARY_RESCORE_OVERSAMPLE}
        return {_VECTOR_FIELD: clause}

    def vector_search(self, index: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        body = {"query": {"knn": self._knn(index, vector, limit, ef)}, "size": limit, "_source": False}
        return self._post_search(index, body)

    def hybrid_search(self, index: str, term: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        self._ensure_pipeline()
        body = {
            "query": {
                "hybrid": {
                    "pagination_depth": limit,
                    "queries": [
                        {"match": {"text": {"query": term}}},
                        {"knn": self._knn(index, vector, limit, ef)},
                    ],
                }
            },
            "size": limit,
            "_source": False,
        }
        return self._post_search(index, body, params={"search_pipeline": _PIPELINE})
