"""Information-retrieval benchmark harness that drives Narsil over HTTP.

Loads standard BEIR datasets through ir_datasets, ingests each corpus into a
running Narsil server, runs the dataset's test queries, writes a TREC run file,
and scores it with pytrec_eval. Keyword (BM25) retrieval only.
"""

__version__ = "0.1.0"
