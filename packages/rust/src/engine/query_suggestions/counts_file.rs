use std::collections::HashSet;

use jiff::civil::Date;

use super::constants::{
    KEY_FINGERPRINT_BYTES, MAX_HISTORY_FILE_BYTES, MAX_INDEX_UUID_LENGTH, MAX_MAX_LENGTH,
    MAX_MAX_WORDS, MAX_PEOPLE_PER_PHRASE_IN_FILE, SCRAMBLED_ID_BYTES,
};
pub(crate) use super::counts_encode::encode_counts_file;
use super::counts_encode::{
    KEY_COUNT, KEY_DAY, KEY_FINGERPRINT, KEY_GROUPS, KEY_INDEX_UUID, KEY_PEOPLE, KEY_PHRASE,
    KEY_SAVED_AT, QUERY_COUNTS_FILE_FORMAT_VERSION, WHAT, sealed, write_top_level,
};
use super::phrase::{PhraseLimits, is_group, is_normal_phrase};
use super::scramble::ScrambledId;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Expectation, Payload, open_checksummed};
use crate::value::Decoder;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const FILE_LIMITS: PhraseLimits = PhraseLimits {
    min_letters: 1,
    max_length: MAX_MAX_LENGTH,
    max_words: MAX_MAX_WORDS,
    max_digits: MAX_MAX_LENGTH,
};

/// One phrase that a counts file holds, as a visitor receives it.
pub(crate) struct VisitedPhrase<'a> {
    pub(crate) group: &'a str,
    pub(crate) phrase: &'a str,
    pub(crate) count: u64,
    pub(crate) people: &'a [ScrambledId],
}

/// A counts file that opened under the key of this engine.
pub(crate) struct OpenedCounts<'a> {
    pub(crate) day: String,
    pub(crate) saved_at: u64,
    fingerprint: [u8; KEY_FINGERPRINT_BYTES],
    payload: Payload<'a>,
    groups_start: usize,
    groups_end: usize,
}

/// What opening a counts file found.
pub(crate) enum OpenedCountsFile<'a> {
    Counts(OpenedCounts<'a>),
    Damaged(String),
    OtherKey,
}

/// Reports whether `value` is a calendar date written as `YYYY-MM-DD`.
pub(crate) fn is_day(value: &str) -> bool {
    let bytes = value.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        });
    if !shaped {
        return false;
    }
    let part =
        |range: std::ops::Range<usize>| value.get(range).and_then(|text| text.parse::<i16>().ok());
    match (part(0..4), part(5..7), part(8..10)) {
        (Some(year), Some(month), Some(day)) => {
            let (Ok(month), Ok(day)) = (i8::try_from(month), i8::try_from(day)) else {
                return false;
            };
            Date::new(year, month, day).is_ok()
        }
        _ => false,
    }
}

fn malformed(reason: impl Into<String>) -> NarsilError {
    NarsilError::new(ErrorCode::PERSISTENCE_LOAD_FAILED, reason.into())
}

fn read_uint(reader: &mut Decoder<'_>) -> Result<u64> {
    match reader.peek()? {
        0x00..=0x7f | 0xcc..=0xcf => {}
        _ => return Err(malformed("Expected an unsigned integer")),
    }
    let value = reader.read_number()?;
    if value > MAX_SAFE_INTEGER {
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

fn walk_groups(
    reader: &mut Decoder<'_>,
    validating: bool,
    visitor: &mut dyn FnMut(&VisitedPhrase<'_>) -> Result<()>,
    on_group: &mut dyn FnMut(&str),
) -> Result<()> {
    let group_count = reader.read_map_length()?;
    let mut seen_groups: HashSet<&str> = HashSet::new();
    let mut people: Vec<ScrambledId> = Vec::new();
    for _ in 0..group_count {
        let group = reader.read_str()?;
        on_group(group);
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
            visitor(&VisitedPhrase {
                group,
                phrase,
                count,
                people: &people,
            })?;
        }
    }
    Ok(())
}

struct TopLevel {
    day: String,
    fingerprint: Vec<u8>,
    saved_at: u64,
    groups_start: usize,
    groups_end: usize,
}

fn read_top_level(payload: &[u8]) -> Result<TopLevel> {
    let mut reader = Decoder::new(payload);
    let keys = reader.read_map_length()?;
    let (mut day, mut fingerprint, mut saved_at, mut groups) = (None, None, None, None);
    let mut seen: HashSet<&str> = HashSet::new();
    for _ in 0..keys {
        let key = reader.read_str()?;
        if !seen.insert(key) {
            return Err(malformed(format!(
                "The file holds the key \"{}\" twice",
                key.escape_debug()
            )));
        }
        match key {
            KEY_DAY => day = Some(reader.read_str()?.to_string()),
            KEY_FINGERPRINT => fingerprint = Some(reader.read_bin()?.to_vec()),
            KEY_SAVED_AT => saved_at = Some(read_uint(&mut reader)?),
            KEY_INDEX_UUID => {
                let uuid = reader.read_str()?;
                let length = uuid.chars().map(char::len_utf16).sum::<usize>();
                if length == 0 || length > MAX_INDEX_UUID_LENGTH {
                    return Err(malformed("The file holds an indexUuid of the wrong length"));
                }
            }
            KEY_GROUPS => {
                let start = reader.position();
                walk_groups(&mut reader, true, &mut |_| Ok(()), &mut |_| {})?;
                groups = Some((start, reader.position()));
            }
            other => {
                return Err(malformed(format!(
                    "The file holds an unexpected key \"{}\"",
                    other.escape_debug()
                )));
            }
        }
    }
    if !reader.is_finished() {
        return Err(malformed("The payload holds bytes after its map"));
    }
    match (day, fingerprint, saved_at, groups) {
        (Some(day), Some(fingerprint), Some(saved_at), Some((groups_start, groups_end))) => {
            Ok(TopLevel {
                day,
                fingerprint,
                saved_at,
                groups_start,
                groups_end,
            })
        }
        _ => Err(malformed("The file lacks a required key")),
    }
}

/// Opens a counts file, reporting it damaged where it breaks a rule of the format or holds another day than
/// `expected_day`, and reporting another key where a different key scrambled its people.
pub(crate) fn open_counts_file<'a>(
    bytes: &'a [u8],
    expected_day: Option<&str>,
    fingerprint: &[u8; KEY_FINGERPRINT_BYTES],
) -> OpenedCountsFile<'a> {
    if bytes.len() as u64 > MAX_HISTORY_FILE_BYTES {
        return OpenedCountsFile::Damaged(format!(
            "The file is longer than {MAX_HISTORY_FILE_BYTES} bytes"
        ));
    }
    let expectation = Expectation {
        version: QUERY_COUNTS_FILE_FORMAT_VERSION,
        what: WHAT,
        allows_compression: false,
    };
    let payload = match open_checksummed(bytes, &expectation) {
        Ok((_, payload)) => payload,
        Err(error) => return OpenedCountsFile::Damaged(error.message().to_string()),
    };
    let top = match read_top_level(payload.bytes()) {
        Ok(top) => top,
        Err(error) => return OpenedCountsFile::Damaged(error.message().to_string()),
    };
    if !is_day(&top.day) || expected_day.is_some_and(|day| day != top.day) {
        return OpenedCountsFile::Damaged(
            "The file holds a day that differs from its key".to_string(),
        );
    }
    let Ok(found) = <[u8; KEY_FINGERPRINT_BYTES]>::try_from(top.fingerprint.as_slice()) else {
        return OpenedCountsFile::Damaged("The key fingerprint has the wrong length".to_string());
    };
    if &found != fingerprint {
        return OpenedCountsFile::OtherKey;
    }
    OpenedCountsFile::Counts(OpenedCounts {
        day: top.day,
        saved_at: top.saved_at,
        fingerprint: found,
        payload,
        groups_start: top.groups_start,
        groups_end: top.groups_end,
    })
}

impl OpenedCounts<'_> {
    fn groups_reader(&self) -> Decoder<'_> {
        let bytes = self.payload.bytes();
        Decoder::new(bytes.get(self.groups_start..self.groups_end).unwrap_or(&[]))
    }

    /// Calls `visitor` with every phrase that the file holds, in the order of the file.
    pub(crate) fn visit(
        &self,
        visitor: &mut dyn FnMut(&VisitedPhrase<'_>) -> Result<()>,
    ) -> Result<()> {
        walk_groups(&mut self.groups_reader(), false, visitor, &mut |_| {})
    }

    /// Returns the name of every group that the file holds.
    pub(crate) fn group_names(&self) -> Result<Vec<String>> {
        let mut names = Vec::new();
        walk_groups(
            &mut self.groups_reader(),
            false,
            &mut |_| Ok(()),
            &mut |group| names.push(group.to_string()),
        )?;
        Ok(names)
    }

    /// Returns the file again with `index_uuid` and `saved_at` in place of its own, its counts unchanged.
    pub(crate) fn with_index_uuid(
        &self,
        index_uuid: Option<&str>,
        saved_at: u64,
    ) -> Result<Vec<u8>> {
        let groups = self
            .payload
            .bytes()
            .get(self.groups_start..self.groups_end)
            .unwrap_or(&[]);
        let mut payload = Vec::with_capacity(groups.len() + SCRAMBLED_ID_BYTES * 8);
        write_top_level(
            &mut payload,
            &self.day,
            &self.fingerprint,
            saved_at,
            index_uuid,
        );
        payload.extend_from_slice(groups);
        sealed(&payload)
    }
}
