use super::constants::{MAX_BAN_LIST_BYTES, MAX_BANNED_PHRASE_CODE_POINTS, MAX_BANNED_PHRASES};
use super::phrase::{PhraseLimits, accepted_phrase, is_normal_phrase};
use super::setting::invalid_setting;
use crate::error::Result;
use crate::value::{Value, encode_value};

const BAN_LIMITS: PhraseLimits = PhraseLimits {
    min_letters: 0,
    max_length: MAX_BANNED_PHRASE_CODE_POINTS,
    max_words: MAX_BANNED_PHRASE_CODE_POINTS,
    max_digits: MAX_BANNED_PHRASE_CODE_POINTS,
};

fn require_within_limits(phrases: &[String]) -> Result<()> {
    if phrases.len() > MAX_BANNED_PHRASES {
        return Err(invalid_setting(format!(
            "A ban list holds at most {MAX_BANNED_PHRASES} phrases, got {}",
            phrases.len()
        )));
    }
    let encoded = encode_value(&ban_list_to_wire(phrases)).map_or(usize::MAX, |bytes| bytes.len());
    if encoded > MAX_BAN_LIST_BYTES {
        return Err(invalid_setting(format!(
            "A ban list must encode to at most {MAX_BAN_LIST_BYTES} bytes"
        )));
    }
    Ok(())
}

/// Returns a ban list as the list that a file holds.
pub(crate) fn ban_list_to_wire(phrases: &[String]) -> Value {
    Value::Array(phrases.iter().cloned().map(Value::String).collect())
}

/// Returns the normal form of a phrase that a caller bans, refusing one that no ban can hold.
pub(crate) fn normalise_ban(raw: &str) -> Result<String> {
    accepted_phrase(raw, &BAN_LIMITS).ok_or_else(|| {
        invalid_setting(format!(
            "A banned phrase must hold up to {MAX_BANNED_PHRASE_CODE_POINTS} letters, digits, spaces, hyphens, and apostrophes"
        ))
    })
}

/// Returns the ban list that a caller gives, each phrase in normal form and once, in the order given.
pub(crate) fn ban_list_from_input(raw: &[String]) -> Result<Vec<String>> {
    if raw.len() > MAX_BANNED_PHRASES {
        return Err(invalid_setting(format!(
            "A ban list holds at most {MAX_BANNED_PHRASES} phrases, got {}",
            raw.len()
        )));
    }
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

/// Reads a stored ban list, refusing with `CONFIG_INVALID` one that holds a phrase out of normal form or twice.
pub(crate) fn stored_ban_list(raw: &Value) -> Result<Vec<String>> {
    let Value::Array(items) = raw else {
        return Err(invalid_setting("The stored ban list is not an array"));
    };
    if items.len() > MAX_BANNED_PHRASES {
        return Err(invalid_setting(format!(
            "A ban list holds at most {MAX_BANNED_PHRASES} phrases, got {}",
            items.len()
        )));
    }
    let mut phrases: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let normal = match item {
            Value::String(phrase) if is_normal_phrase(phrase, &BAN_LIMITS) => phrase,
            _ => {
                return Err(invalid_setting(
                    "The stored ban list holds a phrase that is not in normal form, or one twice",
                ));
            }
        };
        if phrases.contains(normal) {
            return Err(invalid_setting(
                "The stored ban list holds a phrase that is not in normal form, or one twice",
            ));
        }
        phrases.push(normal.clone());
    }
    require_within_limits(&phrases)?;
    Ok(phrases)
}

/// Returns the union of two ban lists, the first list's phrases first.
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
