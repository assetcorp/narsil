import importlib.metadata
import re
from dataclasses import dataclass
from pathlib import Path

PACKAGES_ROOT = Path(__file__).resolve().parents[3]
ENGLISH_MODULE = PACKAGES_ROOT / "ts" / "src" / "languages" / "english.ts"
ENGLISH_STEMMER_MODULE = PACKAGES_ROOT / "ts" / "src" / "languages" / "snowball" / "english.ts"
PINNED_ENGLISH_REVISION = "ebae3448ae674b59"
ENGLISH_SPLIT_PATTERN = r"[^\p{L}\p{M}\p{N}_']+"
STEMMER_DISTRIBUTION = "snowballstemmer"
MAX_MODULE_BYTES = 1_048_576

REVISION = re.compile(r"^\s*revision:\s*'([0-9a-f]+)',\s*$", re.MULTILINE)
STOP_WORD_BLOCK = re.compile(r"^const stopWords = new Set\(\[\n(.*?)\n\]\)\s*$", re.MULTILINE | re.DOTALL)
STOP_WORD_ENTRY = re.compile(r"""^\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)"),\s*$""")
SPLIT_PATTERN = re.compile(r"^\s*splitPattern:\s*/(.*)/u,\s*$", re.MULTILINE)
STRIP_POSSESSIVE = re.compile(r"^\s*stripPossessive:\s*true,\s*$", re.MULTILINE)
SNOWBALL_COMPILER = re.compile(r"by the Snowball compiler (\d+\.\d+\.\d+)\.")


class ModuleError(Exception):
    pass


@dataclass(frozen=True)
class EnglishModule:
    stop_words: frozenset[str]
    snowball_version: str


def module_text(path: Path) -> str:
    if path.stat().st_size > MAX_MODULE_BYTES:
        raise ModuleError(f"{path} is larger than {MAX_MODULE_BYTES} bytes")
    return path.read_text("utf-8")


def single_match(pattern: re.Pattern[str], text: str, what: str) -> re.Match[str]:
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise ModuleError(f"{ENGLISH_MODULE} holds {len(matches)} {what} where the oracle reads exactly one")
    return matches[0]


def stop_words_of(block: str) -> frozenset[str]:
    words: set[str] = set()
    for number, line in enumerate(block.splitlines(), start=1):
        entry = STOP_WORD_ENTRY.match(line)
        if entry is None:
            raise ModuleError(f"line {number} of the stop word list in {ENGLISH_MODULE} is not one quoted word")
        words.add(entry.group(1) if entry.group(1) is not None else entry.group(2))
    return frozenset(words)


def english_module() -> EnglishModule:
    text = module_text(ENGLISH_MODULE)
    revision = single_match(REVISION, text, "revisions").group(1)
    if revision != PINNED_ENGLISH_REVISION:
        raise ModuleError(
            f"the English module carries revision {revision} where the oracle pins {PINNED_ENGLISH_REVISION}, "
            "so check its analysis against the oracle before you move the pin"
        )
    split_pattern = single_match(SPLIT_PATTERN, text, "split patterns").group(1)
    if split_pattern != ENGLISH_SPLIT_PATTERN:
        raise ModuleError(f"the English module splits on {split_pattern} where the oracle splits on {ENGLISH_SPLIT_PATTERN}")
    single_match(STRIP_POSSESSIVE, text, "possessive settings")
    stop_words = stop_words_of(single_match(STOP_WORD_BLOCK, text, "stop word lists").group(1))
    compiler = SNOWBALL_COMPILER.search(module_text(ENGLISH_STEMMER_MODULE))
    if compiler is None:
        raise ModuleError(f"{ENGLISH_STEMMER_MODULE} names no Snowball compiler version")
    installed = importlib.metadata.version(STEMMER_DISTRIBUTION)
    if compiler.group(1) != installed:
        raise ModuleError(
            f"the English stemmer comes from Snowball {compiler.group(1)}, while the oracle has {STEMMER_DISTRIBUTION} {installed}"
        )
    return EnglishModule(stop_words, installed)
