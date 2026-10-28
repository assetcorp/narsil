from __future__ import annotations

import gzip
import hashlib
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx

from ..drivers._stop_words import LUCENE_ENGLISH_STOP_WORDS, NARSIL_ENGLISH_STOP_WORDS
from .synonym_sets import MAX_RULE_WORDS, SynonymRule, parse_synonym_set

OEWN_2024_URL = (
    "https://github.com/globalwordnet/english-wordnet/releases/download/2024-edition/english-wordnet-2024.xml.gz"
)
OEWN_2024_SHA256 = "e1f633b0a93758cae34ea27c44c4dad310a8af2467b155f99dd6673af697e875"
OEWN_2024_ARCHIVE = "english-wordnet-2024.xml.gz"
OEWN_ATTRIBUTION = "Open English WordNet 2024, CC BY 4.0, https://github.com/globalwordnet/english-wordnet"

_PLAIN_LOWERCASE_WORD = re.compile(r"^[a-z]+$")
_STOP_WORDS = frozenset(LUCENE_ENGLISH_STOP_WORDS) | frozenset(NARSIL_ENGLISH_STOP_WORDS)
_DOWNLOAD_TIMEOUT_SECONDS = 300.0


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_wordnet(cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive = cache_dir / OEWN_2024_ARCHIVE
    if not archive.is_file():
        partial = archive.with_suffix(".partial")
        with httpx.stream("GET", OEWN_2024_URL, follow_redirects=True, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as response:
            response.raise_for_status()
            with partial.open("wb") as handle:
                for block in response.iter_bytes():
                    handle.write(block)
        partial.replace(archive)
    found = _sha256(archive)
    if found != OEWN_2024_SHA256:
        archive.unlink()
        raise ValueError(f"{OEWN_2024_URL} has SHA-256 {found}, not the pinned {OEWN_2024_SHA256}")
    return archive


def wordnet_rules(archive: Path) -> tuple[SynonymRule, ...]:
    by_synset: dict[str, set[str]] = {}
    lemma: str | None = None
    with gzip.open(archive, "rb") as handle:
        for _, element in ET.iterparse(handle, events=("end",)):
            if element.tag == "Lemma":
                lemma = element.get("writtenForm")
            elif element.tag == "Sense":
                synset = element.get("synset")
                if (
                    synset is not None
                    and lemma is not None
                    and _PLAIN_LOWERCASE_WORD.match(lemma)
                    and lemma not in _STOP_WORDS
                ):
                    by_synset.setdefault(synset, set()).add(lemma)
            elif element.tag == "LexicalEntry":
                lemma = None
                element.clear()
    raw = [
        {"words": sorted(words)[:MAX_RULE_WORDS]}
        for _, words in sorted(by_synset.items())
        if len(words) >= 2
    ]
    return parse_synonym_set(raw)

