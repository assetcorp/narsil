import unicodedata
from collections.abc import Callable

FULL_WIDTH_FIRST = 0xFF01
FULL_WIDTH_LAST = 0xFF5E
FULL_WIDTH_OFFSET = 0xFEE0
HALF_WIDTH_KATAKANA_FIRST = 0xFF61
HALF_WIDTH_KATAKANA_LAST = 0xFF9D
HALF_WIDTH_VOICED_MARK = 0xFF9E
HALF_WIDTH_SEMI_VOICED_MARK = 0xFF9F
COMBINING_VOICED_MARK = "゙"
COMBINING_SEMI_VOICED_MARK = "゚"
APOSTROPHE = "'"
APOSTROPHE_VARIANTS = frozenset("‘’ʼʻ")
DOTTED_CAPITAL_I = "İ"
REMOVED_MARKS = frozenset(["̇", *(chr(point) for point in range(0x055B, 0x0560))])
ENGLISH_KEPT_INSIDE_TOKENS = frozenset(["_", APOSTROPHE])
KEPT_CATEGORY_CLASSES = frozenset("LMN")
ENGLISH_MIN_TOKEN_LENGTH = 1


def folded_width(character: str) -> str:
    point = ord(character)
    if FULL_WIDTH_FIRST <= point <= FULL_WIDTH_LAST:
        return chr(point - FULL_WIDTH_OFFSET)
    if HALF_WIDTH_KATAKANA_FIRST <= point <= HALF_WIDTH_KATAKANA_LAST:
        return unicodedata.normalize("NFKC", character)
    if point == HALF_WIDTH_VOICED_MARK:
        return COMBINING_VOICED_MARK
    if point == HALF_WIDTH_SEMI_VOICED_MARK:
        return COMBINING_SEMI_VOICED_MARK
    return character


def mapped_marks(character: str) -> str:
    if character in APOSTROPHE_VARIANTS:
        return APOSTROPHE
    if character == DOTTED_CAPITAL_I:
        return "i"
    if character in REMOVED_MARKS:
        return ""
    return character


def is_token_character(character: str) -> bool:
    return character in ENGLISH_KEPT_INSIDE_TOKENS or unicodedata.category(character)[0] in KEPT_CATEGORY_CLASSES


def split_parts(text: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    for character in text:
        if is_token_character(character):
            current.append(character)
        elif current:
            parts.append("".join(current))
            current = []
    if current:
        parts.append("".join(current))
    return parts


def without_possessive(part: str) -> str:
    if part.endswith(APOSTROPHE + "s"):
        return part[:-2]
    if part.endswith(APOSTROPHE):
        return part[:-1]
    return part


class EnglishAnalyser:
    def __init__(self, stop_words: frozenset[str], stem: Callable[[str], str]) -> None:
        self.stop_words = stop_words
        self.stem = stem
        self.stems: dict[str, str] = {}

    def tokens(self, text: str) -> list[str]:
        if not text.isascii():
            text = "".join(folded_width(character) for character in text)
            text = unicodedata.normalize("NFC", text)
            text = "".join(mapped_marks(character) for character in text)
        tokens: list[str] = []
        for part in split_parts(text.lower()):
            token = without_possessive(part)
            if len(token) < ENGLISH_MIN_TOKEN_LENGTH or token in self.stop_words:
                continue
            stemmed = self.stems.get(token)
            if stemmed is None:
                stemmed = self.stem(token)
                self.stems[token] = stemmed
            tokens.append(stemmed)
        return tokens
