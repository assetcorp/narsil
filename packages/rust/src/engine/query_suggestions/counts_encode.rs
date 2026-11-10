use super::constants::{KEY_FINGERPRINT_BYTES, MAX_HISTORY_FILE_BYTES};
use super::day_counts::DayCounts;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Compression, pack};
use crate::value::{write_array_header, write_binary, write_map_header, write_string, write_uint};

pub(crate) const WHAT: &str = "query counts file";
pub(crate) const QUERY_COUNTS_FILE_FORMAT_VERSION: u8 = 1;
pub(crate) const KEY_DAY: &str = "day";
pub(crate) const KEY_FINGERPRINT: &str = "keyFingerprint";
pub(crate) const KEY_SAVED_AT: &str = "savedAt";
pub(crate) const KEY_INDEX_UUID: &str = "indexUuid";
pub(crate) const KEY_GROUPS: &str = "groups";
pub(crate) const KEY_PHRASE: &str = "phrase";
pub(crate) const KEY_COUNT: &str = "count";
pub(crate) const KEY_PEOPLE: &str = "people";
pub(crate) const REQUIRED_TOP_LEVEL_KEYS: usize = 4;
pub(crate) const PHRASE_KEYS: usize = 3;

/// Writes the keys of a counts file that come before its groups, ending with the `groups` key itself.
pub(crate) fn write_top_level(
    out: &mut Vec<u8>,
    day: &str,
    fingerprint: &[u8],
    saved_at: u64,
    index_uuid: Option<&str>,
) {
    write_map_header(
        out,
        REQUIRED_TOP_LEVEL_KEYS + usize::from(index_uuid.is_some()),
    );
    write_string(out, KEY_DAY);
    write_string(out, day);
    write_string(out, KEY_FINGERPRINT);
    write_binary(out, fingerprint);
    write_string(out, KEY_SAVED_AT);
    write_uint(out, saved_at);
    if let Some(index_uuid) = index_uuid {
        write_string(out, KEY_INDEX_UUID);
        write_string(out, index_uuid);
    }
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

/// Seals a counts payload in its envelope, refusing a file past the size limit with `PERSISTENCE_SAVE_FAILED`.
pub(crate) fn sealed(payload: &[u8]) -> Result<Vec<u8>> {
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

/// Encodes the counts of one day as a counts file.
pub(crate) fn encode_counts_file(
    counts: &DayCounts,
    fingerprint: &[u8; KEY_FINGERPRINT_BYTES],
    saved_at: u64,
    index_uuid: Option<&str>,
) -> Result<Vec<u8>> {
    let mut payload = Vec::new();
    write_top_level(&mut payload, &counts.day, fingerprint, saved_at, index_uuid);
    write_groups(&mut payload, counts);
    sealed(&payload)
}
