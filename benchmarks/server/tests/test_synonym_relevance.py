from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ir_bench.core import wordnet_synonyms
from ir_bench.core.config import BM25Params, EngineConfig
from ir_bench.core.synonym_sets import (
    MAX_RULE_WORDS,
    MAX_RULES,
    MAX_WORD_BYTES,
    MAX_WORDS,
    SynonymRule,
    parse_synonym_set,
    solr_rules,
)
from ir_bench.drivers.elasticsearch import ElasticsearchDriver
from ir_bench.drivers.narsil import NarsilDriver
from ir_bench.relevance import scratch_directory

RULES = (SynonymRule(words=("car", "automobile")), SynonymRule(words=("lorry", "truck"), word="van"))


def _engine(name: str, analyzer: str | None) -> EngineConfig:
    return EngineConfig(
        name=name, url="http://engine", run_tag=f"{name}_bm25", ranking="bm25", analyzer=analyzer, language=None,
        tracks=("keyword",),
    )


def _recording(driver, sent: list[tuple[str, str, dict]]):
    def answer(request: httpx.Request) -> httpx.Response:
        sent.append((request.method, request.url.path, json.loads(request.content or b"null")))
        return httpx.Response(200, json={})

    driver._client = httpx.Client(base_url="http://engine", transport=httpx.MockTransport(answer))
    return driver


def test_a_set_at_each_engine_limit_is_taken_and_one_word_more_is_refused() -> None:
    assert len(parse_synonym_set([{"words": ["a", "b"]}] * MAX_RULES)) == MAX_RULES
    with pytest.raises(ValueError, match="at most 100000 rules"):
        parse_synonym_set([{"words": ["a", "b"]}] * (MAX_RULES + 1))

    words_per_rule = MAX_RULE_WORDS
    full = [{"words": [f"w{i}"] * words_per_rule} for i in range(MAX_WORDS // words_per_rule)]
    assert len(parse_synonym_set(full)) == MAX_WORDS // words_per_rule
    with pytest.raises(ValueError, match="at most 500000 words"):
        parse_synonym_set([*full, {"words": ["x", "y"]}])

    long_word = "z" * (MAX_WORD_BYTES // 2)
    assert parse_synonym_set([{"words": [long_word, long_word]}])
    with pytest.raises(ValueError, match="UTF-8 bytes"):
        parse_synonym_set([{"words": [long_word, long_word + "z"]}])

    with pytest.raises(ValueError, match="2 to 100 words"):
        parse_synonym_set([{"words": ["a"] * (MAX_RULE_WORDS + 1)}])


@pytest.mark.parametrize(
    "rule",
    [
        {"words": ["car", "auto, mobile"]},
        {"words": ["car", "auto=>mobile"]},
        {"words": ["car", "two words"]},
        {"words": ["car", "#comment"]},
        {"words": ["car", 7]},
        {"word": "car", "synonyms": []},
        {"word": "car", "words": ["auto", "mobile"]},
        {"words": ["car", "auto"], "extra": True},
        "car, auto",
    ],
)
def test_a_rule_that_would_change_the_meaning_of_the_solr_format_is_refused(rule: object) -> None:
    with pytest.raises(ValueError):
        parse_synonym_set([rule])


def test_elasticsearch_expands_queries_after_the_stemmer_and_indexes_with_the_builtin_english_analyzer() -> None:
    sent: list[tuple[str, str, dict]] = []
    driver = _recording(ElasticsearchDriver(_engine("elasticsearch", "english"), BM25Params(k1=0.9, b=0.4)), sent)

    driver.create_index("plain")
    driver.create_index("expanded", RULES)

    plain, expanded = sent[0][2], sent[1][2]
    assert "analysis" not in plain["settings"]["index"]
    assert plain["mappings"]["properties"]["text"] == {"type": "text", "analyzer": "english"}
    analysis = expanded["settings"]["index"]["analysis"]
    chain = analysis["analyzer"]["english_with_synonyms"]["filter"]
    assert chain == ["english_possessive_stemmer", "lowercase", "english_stop", "english_stemmer", "query_synonyms"]
    assert analysis["filter"]["query_synonyms"] == {
        "type": "synonym_graph",
        "synonyms": ["car, automobile", "van => van, lorry, truck"],
    }
    assert expanded["mappings"]["properties"]["text"] == {
        "type": "text",
        "analyzer": "english",
        "search_analyzer": "english_with_synonyms",
    }
    assert expanded["settings"]["index"]["similarity"] == plain["settings"]["index"]["similarity"]


def test_narsil_sends_the_same_index_config_without_a_set_and_the_rules_with_one() -> None:
    sent: list[tuple[str, str, dict]] = []
    driver = _recording(NarsilDriver(_engine("narsil", None), BM25Params(k1=0.9, b=0.4)), sent)

    driver.create_index("plain")
    driver.create_index("expanded", RULES)

    assert sent[0][2] == {"name": "plain", "config": {"schema": {"text": "string"}, "bm25": {"k1": 0.9, "b": 0.4}}}
    assert sent[1][2]["config"]["synonyms"] == [
        {"words": ["car", "automobile"]},
        {"word": "van", "synonyms": ["lorry", "truck"]},
    ]
    assert solr_rules(RULES) == ["car, automobile", "van => van, lorry, truck"]


def _lmf(entries: list[tuple[str, list[str]]]) -> bytes:
    body = "".join(
        f'<LexicalEntry id="e{i}"><Lemma writtenForm="{form}" partOfSpeech="n"/>'
        + "".join(f'<Sense id="s{i}-{j}" synset="{synset}"/>' for j, synset in enumerate(synsets))
        + "</LexicalEntry>"
        for i, (form, synsets) in enumerate(entries)
    )
    return gzip.compress(f'<?xml version="1.0"?><LexicalResource><Lexicon id="oewn">{body}</Lexicon></LexicalResource>'.encode())


def test_wordnet_rules_keep_single_lowercase_words_that_are_not_stop_words(tmp_path: Path) -> None:
    archive = tmp_path / "wordnet.xml.gz"
    archive.write_bytes(
        _lmf(
            [
                ("car", ["s2", "s1"]),
                ("automobile", ["s1"]),
                ("motor car", ["s1"]),
                ("Paris", ["s3"]),
                ("capital", ["s3"]),
                ("it", ["s4"]),
                ("information", ["s4"]),
                ("railcar", ["s2"]),
                ("e-mail", ["s5"]),
                ("email", ["s5"]),
                ("car", ["s6"]),
            ]
        )
    )

    assert wordnet_synonyms.wordnet_rules(archive) == (
        SynonymRule(words=("automobile", "car")),
        SynonymRule(words=("car", "railcar")),
    )


def test_a_wordnet_archive_with_another_digest_is_refused_and_removed(tmp_path: Path) -> None:
    archive = tmp_path / wordnet_synonyms.OEWN_2024_ARCHIVE
    archive.write_bytes(b"not the published archive")

    with pytest.raises(ValueError, match="not the pinned"):
        wordnet_synonyms.fetch_wordnet(tmp_path)
    assert not archive.exists()


def test_relevance_runs_are_refused_anywhere_under_a_results_directory(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="scratch directory"):
        scratch_directory(tmp_path / "results" / "runs" / "today")
    assert scratch_directory(tmp_path / "scratch").is_dir()
