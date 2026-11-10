use std::collections::HashSet;

use super::constants::{MAX_MAX_LENGTH, MAX_MAX_WORDS, MAX_PEOPLE_PER_PHRASE_IN_FILE};
use super::phrase::{PhraseLimits, is_group, is_normal_phrase};
use super::scramble::ScrambledId;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Decoder, MAX_SAFE_INTEGER};

pub(crate) const KEY_PHRASE: &str = "phrase";
pub(crate) const KEY_COUNT: &str = "count";
pub(crate) const KEY_PEOPLE: &str = "people";

const FILE_LIMITS: PhraseLimits = PhraseLimits {
    min_letters: 1,
    max_length: MAX_MAX_LENGTH,
    max_words: MAX_MAX_WORDS,
    max_digits: MAX_MAX_LENGTH,
};

pub(crate) struct VisitedPhrase<'a> {
    pub(crate) group: &'a str,
    pub(crate) phrase: &'a str,
    pub(crate) count: u64,
    pub(crate) people: &'a [ScrambledId],
}

pub(crate) enum GroupWalk<'v> {
    Validating,
    Phrases(&'v mut dyn FnMut(&VisitedPhrase<'_>) -> Result<()>),
    GroupNames(&'v mut dyn FnMut(&str)),
}

pub(crate) fn malformed(reason: impl Into<String>) -> NarsilError {
    NarsilError::new(ErrorCode::PERSISTENCE_LOAD_FAILED, reason.into())
}

pub(crate) fn read_uint(reader: &mut Decoder<'_>) -> Result<u64> {
    match reader.peek()? {
        0x00..=0x7f | 0xcc..=0xcf => {}
        _ => return Err(malformed("Expected an unsigned integer")),
    }
    let value = reader.read_number()?;
    if value > MAX_SAFE_INTEGER as f64 {
        return Err(malformed("An integer is out of range"));
    }
    Ok(value as u64)
}

fn read_people(reader: &mut Decoder<'_>, people: &mut Vec<ScrambledId>) -> Result<()> {
    let length = reader.read_array_length()?;
    if length > MAX_PEOPLE_PER_PHRASE_IN_FILE {
        return Err(malformed("A phrase lists too many people"));
    }
    people.clear();
    for _ in 0..length {
        let id: ScrambledId = reader
            .read_bin()?
            .try_into()
            .map_err(|_| malformed("A scrambled ID has the wrong length"))?;
        people.push(id);
    }
    Ok(())
}

pub(crate) fn walk_groups(reader: &mut Decoder<'_>, mut walk: GroupWalk<'_>) -> Result<()> {
    let validating = matches!(walk, GroupWalk::Validating);
    let group_count = reader.read_map_length()?;
    let mut seen_groups: HashSet<&str> = HashSet::new();
    let mut people: Vec<ScrambledId> = Vec::new();
    for _ in 0..group_count {
        let group = reader.read_str()?;
        if let GroupWalk::GroupNames(on_group) = &mut walk {
            on_group(group);
        }
        if validating && (!is_group(group) || !seen_groups.insert(group)) {
            return Err(malformed("A group is invalid or repeated"));
        }
        let phrase_count = reader.read_array_length()?;
        let mut seen_phrases: HashSet<&str> = HashSet::new();
        for _ in 0..phrase_count {
            let fields = reader.read_map_length()?;
            let (mut phrase, mut count, mut listed) = (None, None, false);
            for _ in 0..fields {
                let key = reader.read_str()?;
                match key {
                    KEY_PHRASE if phrase.is_none() => phrase = Some(reader.read_str()?),
                    KEY_COUNT if count.is_none() => count = Some(read_uint(reader)?),
                    KEY_PEOPLE if !listed => {
                        read_people(reader, &mut people)?;
                        listed = true;
                    }
                    _ => {
                        return Err(malformed(format!(
                            "A phrase holds an unexpected or repeated key \"{}\"",
                            key.escape_debug()
                        )));
                    }
                }
            }
            let (Some(phrase), Some(count), true) = (phrase, count, listed) else {
                return Err(malformed("A phrase lacks a key"));
            };
            if validating {
                if !is_normal_phrase(phrase, &FILE_LIMITS) || !seen_phrases.insert(phrase) {
                    return Err(malformed("A phrase is invalid or repeated"));
                }
                if people.len() as u64 > count || count > u64::from(u32::MAX) {
                    return Err(malformed("A phrase lists more people than its count"));
                }
            }
            if let GroupWalk::Phrases(visitor) = &mut walk {
                visitor(&VisitedPhrase {
                    group,
                    phrase,
                    count,
                    people: &people,
                })?;
            }
        }
    }
    Ok(())
}
