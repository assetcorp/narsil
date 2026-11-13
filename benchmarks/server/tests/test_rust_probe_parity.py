from __future__ import annotations

import math
import os
import random
from collections import Counter
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from ir_bench.core.config import load_config
from ir_bench.core.registry import build_driver
from ir_bench.core.types import EQUAL_PRECISION, VectorDoc, VectorIndexParams

SERVER_URL_ENVS = {"narsil": "NARSIL_PARITY_TS_URL", "narsil-rust": "NARSIL_PARITY_RUST_URL"}
CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "benchmark.toml"
INDEX = "probe_parity"
SEED = 20261113
VOCABULARY_SIZE = 300
MIN_WORD_DISTANCE = 3
DOCUMENTS = 600
SHORTEST_DOCUMENT = 4
DIMENSIONS = 16
QUERIES = 60
TOP_K = 10
EF_SEARCH = 256
RRF_K = 60
IMPORT_BATCH = 100
SCORE_TOLERANCE = 1e-6
COSINE_TOLERANCE = 1e-5

pytestmark = pytest.mark.skipif(
    not all(os.environ.get(name) for name in SERVER_URL_ENVS.values()),
    reason="set NARSIL_PARITY_TS_URL and NARSIL_PARITY_RUST_URL to two running servers",
)


def _edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, start=1):
        current = [i]
        for j, b in enumerate(right, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def _vocabulary(rng: random.Random) -> list[str]:
    words: list[str] = []
    while len(words) < VOCABULARY_SIZE:
        word = "".join(rng.choice("bdgkmpt") + rng.choice("aou") for _ in range(3)) + rng.choice("kmpt")
        if all(_edit_distance(word, other) >= MIN_WORD_DISTANCE for other in words):
            words.append(word)
    return words


def _corpus() -> tuple[list[str], list[list[str]], np.ndarray, list[list[str]], np.ndarray]:
    rng = random.Random(SEED)
    vocabulary = _vocabulary(rng)
    weights = [1.0 / (rank + 1) for rank in range(len(vocabulary))]
    texts = [rng.choices(vocabulary, weights=weights, k=SHORTEST_DOCUMENT + i) for i in range(DOCUMENTS)]
    vectors = np.random.default_rng(SEED).standard_normal((DOCUMENTS + QUERIES, DIMENSIONS)).astype(np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    queries = [rng.sample(vocabulary[:60], rng.choice((1, 2, 3))) for _ in range(QUERIES)]
    ids = [f"doc{i:04d}" for i in range(DOCUMENTS)]
    return ids, texts, vectors[:DOCUMENTS], queries, vectors[DOCUMENTS:]


class Oracle:
    def __init__(self, ids: list[str], texts: list[list[str]], vectors: np.ndarray, k1: float, b: float) -> None:
        self.ids = ids
        self.counts = [Counter(words) for words in texts]
        self.lengths = [len(words) for words in texts]
        self.average = sum(self.lengths) / len(self.lengths)
        self.frequency = Counter(word for counts in self.counts for word in counts)
        self.vectors = vectors.astype(np.float64)
        self.k1 = k1
        self.b = b

    def keyword(self, terms: list[str]) -> list[tuple[str, float]]:
        total = len(self.ids)
        scored: list[tuple[str, float]] = []
        for doc_id, counts, length in zip(self.ids, self.counts, self.lengths):
            score = 0.0
            matched = False
            for term in terms:
                tf = counts.get(term, 0)
                if tf == 0:
                    continue
                matched = True
                n = self.frequency[term]
                idf = math.log((total - n + 0.5) / (n + 0.5) + 1.0)
                norm = self.k1 * (1.0 - self.b + self.b * length / self.average)
                score += idf * tf * (self.k1 + 1.0) / (tf + norm)
            if matched:
                scored.append((doc_id, score))
        return sorted(scored, key=lambda pair: (-pair[1], pair[0]))

    def cosine(self, query: np.ndarray) -> list[tuple[str, float]]:
        unit = query.astype(np.float64) / np.linalg.norm(query)
        norms = np.linalg.norm(self.vectors, axis=1)
        scores = (self.vectors @ unit) / norms
        return sorted(zip(self.ids, scores.tolist()), key=lambda pair: (-pair[1], pair[0]))

    def hybrid(self, terms: list[str], query: np.ndarray, depth: int) -> list[tuple[str, float]]:
        fused: dict[str, float] = {}
        for ranking in (self.keyword(terms)[:depth], self.cosine(query)[:depth]):
            for rank, (doc_id, _) in enumerate(ranking, start=1):
                fused[doc_id] = fused.get(doc_id, 0.0) + 1.0 / (RRF_K + rank)
        return sorted(fused.items(), key=lambda pair: (-pair[1], pair[0]))


@pytest.fixture(scope="module")
def loaded():
    config = load_config(CONFIG_PATH)
    ids, texts, vectors, queries, query_vectors = _corpus()
    drivers = {}
    for name, env in SERVER_URL_ENVS.items():
        engine = replace(config.engines[name], url=os.environ[env].rstrip("/"))
        driver = build_driver(engine, config.bm25)
        driver.wait_until_ready()
        driver.drop_index(INDEX)
        driver.create_vector_index(
            INDEX,
            VectorIndexParams(dims=DIMENSIONS, metric="cosine", m=16, ef_construction=200, profile=EQUAL_PRECISION),
        )
        documents = (
            VectorDoc(doc_id=doc_id, text=" ".join(words), vector=vector.tolist())
            for doc_id, words, vector in zip(ids, texts, vectors)
        )
        imported = driver.import_vectors(INDEX, documents, IMPORT_BATCH, 1)
        assert imported.indexed == DOCUMENTS
        driver.build_vectors(INDEX)
        assert driver.count(INDEX) == DOCUMENTS
        drivers[name] = driver
    oracle = Oracle(ids, texts, vectors, config.bm25.k1, config.bm25.b)
    yield drivers, oracle, queries, query_vectors
    for driver in drivers.values():
        driver.drop_index(INDEX)
        driver.close()


def _pairs(response) -> list[tuple[str, float]]:
    return [(hit.doc_id, hit.score) for hit in response.hits]


def _assert_matches(found: list[tuple[str, float]], expected: list[tuple[str, float]], tolerance: float) -> None:
    assert [doc_id for doc_id, _ in found] == [doc_id for doc_id, _ in expected]
    for (_, score), (_, want) in zip(found, expected):
        assert score == pytest.approx(want, rel=tolerance, abs=tolerance)


def test_keyword_hits_match_the_bm25_oracle_on_both_servers(loaded):
    drivers, oracle, queries, _ = loaded
    for terms in queries:
        expected = oracle.keyword(terms)
        answers = {name: driver.search(INDEX, " ".join(terms), TOP_K) for name, driver in drivers.items()}
        for answer in answers.values():
            assert answer.count == len(expected)
            _assert_matches(_pairs(answer), expected[:TOP_K], SCORE_TOLERANCE)
        assert _pairs(answers["narsil"]) == _pairs(answers["narsil-rust"])


def test_vector_hits_match_exact_cosine_on_both_servers(loaded):
    drivers, oracle, _, query_vectors = loaded
    for query in query_vectors:
        expected = oracle.cosine(query)[:TOP_K]
        answers = {name: driver.vector_search(INDEX, query.tolist(), TOP_K, EF_SEARCH) for name, driver in drivers.items()}
        for answer in answers.values():
            _assert_matches(_pairs(answer), expected, COSINE_TOLERANCE)
        assert _pairs(answers["narsil"]) == _pairs(answers["narsil-rust"])


def test_hybrid_hits_match_reciprocal_rank_fusion_on_both_servers(loaded):
    drivers, oracle, queries, query_vectors = loaded
    for terms, query in zip(queries, query_vectors):
        expected = oracle.hybrid(terms, query, TOP_K + 1)[:TOP_K]
        answers = {
            name: driver.hybrid_search(INDEX, " ".join(terms), query.tolist(), TOP_K, EF_SEARCH)
            for name, driver in drivers.items()
        }
        for answer in answers.values():
            _assert_matches(_pairs(answer), expected, SCORE_TOLERANCE)
        assert _pairs(answers["narsil"]) == _pairs(answers["narsil-rust"])
