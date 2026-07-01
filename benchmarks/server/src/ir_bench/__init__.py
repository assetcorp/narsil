"""Engine-neutral information-retrieval benchmark harness.

Loads standard BEIR datasets through ir_datasets, ingests each corpus into a
running search engine over HTTP, runs the dataset's test queries, writes a TREC
run file, and scores it with pytrec_eval. Covers three tracks: keyword (BM25),
dense vector (kNN), and hybrid (keyword + vector). Every engine is exercised
through the same neutral driver interface, the same datasets, the same metrics,
the same run depth, and the same run-file ordering rule. The vector and hybrid
tracks feed every engine identical precomputed vectors and compare latency at a
matched ANN-recall operating point, so the numbers compare directly.
"""

__version__ = "0.1.0"
