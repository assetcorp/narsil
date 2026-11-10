use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategory, GeneralCategoryGroup, UnicodeGeneralCategory};

use super::constants::{
    MAX_GROUP_LENGTH, MAX_PERSON_UTF16_UNITS, RAW_PHRASE_UTF16_UNITS_PER_CODE_POINT,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PhraseLimits {
    pub(crate) min_letters: u32,
    pub(crate) max_length: u32,
    pub(crate) max_words: u32,
    pub(crate) max_digits: u32,
}

const APOSTROPHE: char = '\u{27}';
const HYPHEN: char = '\u{2d}';
const SPACE: char = ' ';

pub(crate) fn utf16_length(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

fn is_letter(character: char) -> bool {
    character.general_category_group() == GeneralCategoryGroup::Letter
}

fn is_digit(character: char) -> bool {
    character.general_category() == GeneralCategory::DecimalNumber
}

fn is_allowed(character: char) -> bool {
    matches!(character, SPACE | HYPHEN | APOSTROPHE)
        || is_letter(character)
        || is_digit(character)
        || character.general_category_group() == GeneralCategoryGroup::Mark
}

fn folded(character: char) -> char {
    match character {
        '\u{2018}' | '\u{2019}' | '\u{2bc}' => APOSTROPHE,
        '\u{2010}' | '\u{2011}' => HYPHEN,
        other => other,
    }
}

pub(crate) fn normalise_phrase(raw: &str, max_length: u32) -> Option<String> {
    let units = utf16_length(raw);
    let ceiling = (max_length as usize).saturating_mul(RAW_PHRASE_UTF16_UNITS_PER_CODE_POINT);
    if units == 0 || units > ceiling {
        return None;
    }
    let composed: String = raw.nfkc().collect();
    let lowered = composed.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut in_space = false;
    for character in lowered.chars().map(folded) {
        if character.is_whitespace() {
            in_space = true;
            continue;
        }
        if in_space && !out.is_empty() {
            out.push(SPACE);
        }
        in_space = false;
        out.push(character);
    }
    Some(out)
}

pub(crate) fn phrase_fits(phrase: &str, limits: &PhraseLimits) -> bool {
    let units = utf16_length(phrase);
    if units == 0 || units > (limits.max_length as usize).saturating_mul(2) {
        return false;
    }
    if phrase.starts_with(SPACE) || phrase.ends_with(SPACE) || phrase.contains("  ") {
        return false;
    }
    let mut code_points: u64 = 0;
    let mut words: u64 = 1;
    let mut digits: u64 = 0;
    let mut letters: u64 = 0;
    for character in phrase.chars() {
        if !is_allowed(character) {
            return false;
        }
        code_points += 1;
        if character == SPACE {
            words += 1;
        } else if is_letter(character) {
            letters += 1;
        } else if is_digit(character) {
            digits += 1;
        }
    }
    code_points <= u64::from(limits.max_length)
        && words <= u64::from(limits.max_words)
        && digits <= u64::from(limits.max_digits)
        && letters >= u64::from(limits.min_letters)
}

pub(crate) fn is_normal_phrase(phrase: &str, limits: &PhraseLimits) -> bool {
    phrase_fits(phrase, limits)
        && normalise_phrase(phrase, limits.max_length).as_deref() == Some(phrase)
}

pub(crate) fn accepted_phrase(raw: &str, limits: &PhraseLimits) -> Option<String> {
    normalise_phrase(raw, limits.max_length).filter(|phrase| phrase_fits(phrase, limits))
}

pub(crate) fn is_group(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some(first) = bytes.first() else {
        return false;
    };
    bytes.len() <= MAX_GROUP_LENGTH
        && first.is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(crate) fn is_person(value: &str) -> bool {
    let units = utf16_length(value);
    units > 0 && units <= MAX_PERSON_UTF16_UNITS
}
