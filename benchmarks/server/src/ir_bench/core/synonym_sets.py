from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

MAX_RULES = 100_000
MAX_WORDS = 500_000
MAX_WORD_BYTES = 4_194_304
MAX_RULE_WORDS = 100

_PLAIN_WORD = re.compile(r"^[^\s,=>\\#]+$")


@dataclass(frozen=True)
class SynonymRule:
    words: tuple[str, ...]
    word: str | None = None


def _require_words(raw: object, where: str, minimum: int, maximum: int) -> tuple[str, ...]:
    if not isinstance(raw, list) or not minimum <= len(raw) <= maximum:
        raise ValueError(f"{where} must be a list of {minimum} to {maximum} words")
    for word in raw:
        if not isinstance(word, str) or not _PLAIN_WORD.match(word):
            raise ValueError(f"{where} holds {word!r}, which is not a plain word")
    return tuple(raw)


def _parse_rule(raw: object, position: int) -> SynonymRule:
    where = f"rule {position}"
    if not isinstance(raw, dict):
        raise ValueError(f"{where} must be an object")
    keys = set(raw)
    if keys == {"words"}:
        return SynonymRule(words=_require_words(raw["words"], f"{where} words", 2, MAX_RULE_WORDS))
    if keys == {"word", "synonyms"}:
        word = raw["word"]
        if not isinstance(word, str) or not _PLAIN_WORD.match(word):
            raise ValueError(f"{where} word {word!r} is not a plain word")
        synonyms = _require_words(raw["synonyms"], f"{where} synonyms", 1, MAX_RULE_WORDS - 1)
        return SynonymRule(words=synonyms, word=word)
    raise ValueError(f"{where} must hold either 'words' alone or 'word' and 'synonyms'")


def parse_synonym_set(raw: object) -> tuple[SynonymRule, ...]:
    if not isinstance(raw, list):
        raise ValueError("a synonym set must be a list of rules")
    if len(raw) > MAX_RULES:
        raise ValueError(f"a synonym set holds at most {MAX_RULES} rules, and this one holds {len(raw)}")
    rules = tuple(_parse_rule(entry, position) for position, entry in enumerate(raw))
    words = [word for rule in rules for word in rule.words] + [rule.word for rule in rules if rule.word is not None]
    if len(words) > MAX_WORDS:
        raise ValueError(f"a synonym set holds at most {MAX_WORDS} words, and this one holds {len(words)}")
    size = sum(len(word.encode("utf-8")) for word in words)
    if size > MAX_WORD_BYTES:
        raise ValueError(f"the words of a synonym set hold at most {MAX_WORD_BYTES} UTF-8 bytes, and these hold {size}")
    return rules


def load_synonym_set(path: Path) -> tuple[SynonymRule, ...]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"cannot read the synonym set at {path}: {error}") from error
    try:
        return parse_synonym_set(raw)
    except ValueError as error:
        raise ValueError(f"{path}: {error}") from error


def narsil_rules(rules: tuple[SynonymRule, ...]) -> list[dict]:
    return [
        {"words": list(rule.words)} if rule.word is None else {"word": rule.word, "synonyms": list(rule.words)}
        for rule in rules
    ]


def solr_rules(rules: tuple[SynonymRule, ...]) -> list[str]:
    lines: list[str] = []
    for rule in rules:
        if rule.word is None:
            lines.append(", ".join(rule.words))
        else:
            lines.append(f"{rule.word} => {', '.join((rule.word, *rule.words))}")
    return lines


def typesense_synonym_items(rules: tuple[SynonymRule, ...], locale: str) -> list[dict]:
    items: list[dict] = []
    for position, rule in enumerate(rules):
        item: dict = {"id": f"rule-{position}", "synonyms": list(rule.words), "locale": locale}
        if rule.word is not None:
            item["root"] = rule.word
        items.append(item)
    return items


def meilisearch_synonyms(rules: tuple[SynonymRule, ...]) -> dict[str, list[str]]:
    mapping: dict[str, dict[str, None]] = {}

    def add(word: str, synonyms: tuple[str, ...]) -> None:
        targets = mapping.setdefault(word, {})
        for synonym in synonyms:
            if synonym != word:
                targets[synonym] = None

    for rule in rules:
        if rule.word is None:
            for word in rule.words:
                add(word, rule.words)
        else:
            add(rule.word, rule.words)
    return {word: list(targets) for word, targets in mapping.items() if targets}
