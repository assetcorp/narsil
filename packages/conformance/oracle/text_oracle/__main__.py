import argparse
import gzip
import json
import sys
from pathlib import Path

import snowballstemmer

from .analysis import EnglishAnalyser
from .bm25 import Hit, TextIndex
from .reference_module import ModuleError, english_module

SCORE_RELATIVE_TOLERANCE = 1e-12
TEXT_FIELD_TYPES = frozenset(["string", "string[]"])
EXPECTED_LANGUAGE = "english"
MAX_DOCUMENTS_TEXT_BYTES = 268_435_456
EXIT_PASSED = 0
EXIT_FAILED = 1
EXIT_UNUSABLE = 2


def read_documents(path: Path) -> list[dict[str, str]]:
    with gzip.open(path, "rb") as stream:
        text = stream.read(MAX_DOCUMENTS_TEXT_BYTES + 1)
    if len(text) > MAX_DOCUMENTS_TEXT_BYTES:
        raise ValueError(f"{path} holds more than {MAX_DOCUMENTS_TEXT_BYTES} bytes of documents")
    documents = []
    for number, line in enumerate(text.decode("utf-8").splitlines(), start=1):
        document = json.loads(line)
        if not isinstance(document, dict) or not all(isinstance(value, str) for value in document.values()):
            raise ValueError(f"line {number} of {path} is not a document of strings")
        documents.append(document)
    return documents


def score_matches(actual: float, committed: float) -> bool:
    return abs(actual - committed) <= SCORE_RELATIVE_TOLERANCE * abs(committed)


def query_problems(query: dict, hits: list[Hit]) -> list[str]:
    committed = query["hits"]
    wanted_ids = [hit["id"] for hit in committed]
    found_ids = [hit.id for hit in hits]
    if found_ids != wanted_ids:
        return [f"query {query['id']} finds {found_ids} where the committed results list {wanted_ids}"]
    problems = []
    for rank, (hit, wanted) in enumerate(zip(hits, committed, strict=True), start=1):
        if not score_matches(hit.score, wanted["score"]):
            problems.append(
                f"query {query['id']} scores {hit.id} at rank {rank} as {hit.score!r} "
                f"where the committed score is {wanted['score']!r}"
            )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(prog="text_oracle")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--searches", type=Path, required=True)
    arguments = parser.parse_args()
    searches = json.loads(arguments.searches.read_text("utf-8"))
    index_settings = searches["index"]
    if index_settings["language"] != EXPECTED_LANGUAGE:
        print(f"the oracle analyses English alone, and the searches use {index_settings['language']}")
        return EXIT_UNUSABLE
    try:
        module = english_module()
    except ModuleError as error:
        print(error)
        return EXIT_UNUSABLE
    stemmer = snowballstemmer.stemmer(EXPECTED_LANGUAGE)
    analyser = EnglishAnalyser(module.stop_words, stemmer.stemWord)
    fields = [field for field, kind in index_settings["schema"].items() if kind in TEXT_FIELD_TYPES]
    documents = read_documents(arguments.dataset / "documents.jsonl.gz")
    index = TextIndex(documents, fields, analyser.tokens)
    limit = searches["text"]["limit"]
    queries = searches["text"]["queries"]
    disagreeing = 0
    for query in queries:
        problems = query_problems(query, index.search(analyser.tokens(query["text"]), limit))
        if problems:
            disagreeing += 1
        for problem in problems:
            print(problem)
    print(f"{len(queries) - disagreeing} of {len(queries)} text queries agree with the oracle")
    return EXIT_FAILED if disagreeing else EXIT_PASSED


if __name__ == "__main__":
    sys.exit(main())
