"""Engine-neutral information-retrieval benchmark harness.

Loads standard BEIR datasets through ir_datasets, ingests each corpus into a
running search engine over HTTP, runs the dataset's test queries, writes a TREC
run file, and scores it with pytrec_eval. Keyword retrieval only. Every engine
is exercised through the same neutral driver interface, the same datasets, the
same metrics, the same run depth, and the same run-file ordering rule, so the
numbers compare directly.
"""

__version__ = "0.2.0"
