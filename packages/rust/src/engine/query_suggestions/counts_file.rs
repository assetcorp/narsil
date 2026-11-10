use std::collections::HashSet;
use std::ops::Range;

use jiff::civil::Date;

use super::constants::{KEY_FINGERPRINT_BYTES, MAX_HISTORY_FILE_BYTES, MAX_INDEX_UUID_LENGTH};
use super::counts_groups::{
    GroupWalk, KEY_COUNT, KEY_PEOPLE, KEY_PHRASE, VisitedPhrase, malformed, read_uint, walk_groups,
};
use super::day_counts::DayCounts;
use super::history_files::is_day_shape;
use super::phrase::utf16_length;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Compression, Expectation, Payload, open_checksummed, pack};
use crate::value::{
    Decoder, write_array_header, write_binary, write_map_header, write_string, write_uint,
};

const WHAT: &str = "query counts file";
const QUERY_COUNTS_FILE_FORMAT_VERSION: u8 = 1;
const KEY_DAY: &str = "day";
const KEY_FINGERPRINT: &str = "keyFingerprint";
const KEY_SAVED_AT: &str = "savedAt";
const KEY_INDEX_UUID: &str = "indexUuid";
const KEY_GROUPS: &str = "groups";
const TOP_LEVEL_KEYS: usize = 4;
const PHRASE_KEYS: usize = 3;

pub(crate) struct OpenedCounts<'a> {
    pub(crate) day: String,
    pub(crate) saved_at: u64,
    fingerprint: [u8; KEY_FINGERPRINT_BYTES],
    payload: Payload<'a>,
    groups: Range<usize>,
}

pub(crate) enum OpenedCountsFile<'a> {
    Counts(OpenedCounts<'a>),
    Damaged(String),
    OtherKey,
}

pub(crate) fn is_day(value: &str) -> bool {
    let part = |range: Range<usize>| value.get(range).and_then(|text| text.parse::<i8>().ok());
    let year = value.get(0..4).and_then(|text| text.parse::<i16>().ok());
    is_day_shape(value)
        && matches!(
            (year, part(5..7), part(8..10)),
            (Some(year), Some(month), Some(day)) if Date::new(year, month, day).is_ok()
        )
}

fn write_top_level(out: &mut Vec<u8>, day: &str, fingerprint: &[u8], saved_at: u64) {
    write_map_header(out, TOP_LEVEL_KEYS);
    write_string(out, KEY_DAY);
    write_string(out, day);
    write_string(out, KEY_FINGERPRINT);
    write_binary(out, fingerprint);
    write_string(out, KEY_SAVED_AT);
    write_uint(out, saved_at);
    write_string(out, KEY_GROUPS);
}

fn write_groups(out: &mut Vec<u8>, counts: &DayCounts) {
    write_map_header(out, counts.groups().len());
    for table in counts.groups() {
        write_string(out, &table.name);
        write_array_header(out, table.order.len());
        for number in &table.order {
            write_map_header(out, PHRASE_KEYS);
            write_string(out, KEY_PHRASE);
            write_string(out, counts.phrase_of(*number));
            write_string(out, KEY_COUNT);
            write_uint(out, u64::from(counts.count_of(*number)));
            write_string(out, KEY_PEOPLE);
            let people = counts.people_of(*number);
            write_array_header(out, people.len());
            for person in people {
                write_binary(out, person);
            }
        }
    }
}

fn sealed(payload: &[u8]) -> Result<Vec<u8>> {
    let file = pack(
        payload,
        QUERY_COUNTS_FILE_FORMAT_VERSION,
        Compression::None,
        WHAT,
    )?;
    if file.len() as u64 > MAX_HISTORY_FILE_BYTES {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!("A query counts file must stay at or below {MAX_HISTORY_FILE_BYTES} bytes"),
        ));
    }
    Ok(file)
}

pub(crate) fn encode_counts_file(
    counts: &DayCounts,
    fingerprint: &[u8; KEY_FINGERPRINT_BYTES],
    saved_at: u64,
) -> Result<Vec<u8>> {
    let mut payload = Vec::new();
    write_top_level(&mut payload, &counts.day, fingerprint, saved_at);
    write_groups(&mut payload, counts);
    sealed(&payload)
}

struct TopLevel {
    day: String,
    fingerprint: Vec<u8>,
    saved_at: u64,
    groups: Range<usize>,
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
                let length = utf16_length(reader.read_str()?);
                if length == 0 || length > MAX_INDEX_UUID_LENGTH {
                    return Err(malformed("The file holds an indexUuid of the wrong length"));
                }
            }
            KEY_GROUPS => {
                let start = reader.position();
                walk_groups(&mut reader, GroupWalk::Validating)?;
                groups = Some(start..reader.position());
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
        (Some(day), Some(fingerprint), Some(saved_at), Some(groups)) => Ok(TopLevel {
            day,
            fingerprint,
            saved_at,
            groups,
        }),
        _ => Err(malformed("The file lacks a required key")),
    }
}

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
    let opened = open_checksummed(bytes, &expectation)
        .and_then(|(_, payload)| Ok((read_top_level(payload.bytes())?, payload)));
    let (top, payload) = match opened {
        Ok(opened) => opened,
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
        groups: top.groups,
    })
}

impl OpenedCounts<'_> {
    fn groups_bytes(&self) -> &[u8] {
        self.payload.bytes().get(self.groups.clone()).unwrap_or(&[])
    }

    pub(crate) fn visit(
        &self,
        visitor: &mut dyn FnMut(&VisitedPhrase<'_>) -> Result<()>,
    ) -> Result<()> {
        walk_groups(
            &mut Decoder::new(self.groups_bytes()),
            GroupWalk::Phrases(visitor),
        )
    }

    pub(crate) fn group_names(&self) -> Result<Vec<String>> {
        let mut names = Vec::new();
        walk_groups(
            &mut Decoder::new(self.groups_bytes()),
            GroupWalk::GroupNames(&mut |group| names.push(group.to_string())),
        )?;
        Ok(names)
    }

    pub(crate) fn without_index_uuid(&self) -> Result<Vec<u8>> {
        let mut payload = Vec::new();
        write_top_level(&mut payload, &self.day, &self.fingerprint, self.saved_at);
        payload.extend_from_slice(self.groups_bytes());
        sealed(&payload)
    }
}
