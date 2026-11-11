use super::constants::{MAX_BAN_LIST_BYTES, MAX_BANNED_PHRASE_CODE_POINTS, MAX_BANNED_PHRASES};
use super::phrase::{PhraseLimits, accepted_phrase, is_normal_phrase};
use crate::error::Result;
use crate::format::metadata_parts::config_invalid;
use crate::value::{Value, encode_value};

const BAN_LIMITS: PhraseLimits = PhraseLimits {
    min_letters: 0,
    max_length: MAX_BANNED_PHRASE_CODE_POINTS,
    max_words: MAX_BANNED_PHRASE_CODE_POINTS,
    max_digits: MAX_BANNED_PHRASE_CODE_POINTS,
};

fn require_count_within_limit(count: usize) -> Result<()> {
    if count > MAX_BANNED_PHRASES {
        return Err(config_invalid(format!(
            "A ban list holds at most {MAX_BANNED_PHRASES} phrases, got {count}"
        )));
    }
    Ok(())
}

fn require_within_limits(phrases: &[String]) -> Result<()> {
    require_count_within_limit(phrases.len())?;
    let encoded = encode_value(&ban_list_to_wire(phrases)).map_or(usize::MAX, |bytes| bytes.len());
    if encoded > MAX_BAN_LIST_BYTES {
        return Err(config_invalid(format!(
            "A ban list must encode to at most {MAX_BAN_LIST_BYTES} bytes"
        )));
    }
    Ok(())
}

pub(crate) fn ban_list_to_wire(phrases: &[String]) -> Value {
    Value::Array(phrases.iter().cloned().map(Value::String).collect())
}

pub(crate) fn normalise_ban(raw: &str) -> Result<String> {
    accepted_phrase(raw, &BAN_LIMITS).ok_or_else(|| {
        config_invalid(format!(
            "A banned phrase must hold up to {MAX_BANNED_PHRASE_CODE_POINTS} letters, digits, spaces, hyphens, and apostrophes"
        ))
    })
}

pub(crate) fn ban_list_from_input(raw: &[String]) -> Result<Vec<String>> {
    require_count_within_limit(raw.len())?;
    let mut phrases: Vec<String> = Vec::with_capacity(raw.len());
    for phrase in raw {
        let normal = normalise_ban(phrase)?;
        if !phrases.contains(&normal) {
            phrases.push(normal);
        }
    }
    require_within_limits(&phrases)?;
    Ok(phrases)
}

pub(crate) fn stored_ban_list(raw: &Value) -> Result<Vec<String>> {
    let Value::Array(items) = raw else {
        return Err(config_invalid("The stored ban list is not an array"));
    };
    require_count_within_limit(items.len())?;
    let mut phrases: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::String(phrase)
                if is_normal_phrase(phrase, &BAN_LIMITS) && !phrases.contains(phrase) =>
            {
                phrases.push(phrase.clone());
            }
            _ => {
                return Err(config_invalid(
                    "The stored ban list holds a phrase that is not in normal form, or one twice",
                ));
            }
        }
    }
    require_within_limits(&phrases)?;
    Ok(phrases)
}

pub(crate) fn union_of_bans(first: &[String], second: &[String]) -> Result<Vec<String>> {
    let mut union = first.to_vec();
    for phrase in second {
        if !union.contains(phrase) {
            union.push(phrase.clone());
        }
    }
    require_within_limits(&union)?;
    Ok(union)
}
