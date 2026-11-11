mod support;

use std::ops::Range;

use narsil::{ErrorCode, IndexConfig, Map, Narsil, Storage, Value, parse_json};
use support::ScratchDirectory;
use support::portable::{Tier, snapshot_of};

const INDEX: &str = "notes";
const TAR_BLOCK: usize = 512;
const ENVELOPE_BYTES: usize = 32;
const HEAD_PREFIX_BYTES: usize = 8;

fn config() -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title":"string"}"#).unwrap(),
        text_storage: Some(Storage::Disk),
        ..IndexConfig::default()
    }
}

fn insert(engine: &Narsil, id: &str) {
    let mut document = Map::new();
    document.insert("title", Value::String(id.into()));
    engine.insert(INDEX, document, Some(id)).unwrap();
}

fn entry_body(archive: &[u8], name: &str) -> Range<usize> {
    let mut at = 0;
    while at + TAR_BLOCK <= archive.len() {
        let header = &archive[at..at + TAR_BLOCK];
        let text = std::str::from_utf8(&header[124..136]).unwrap();
        let length = usize::from_str_radix(text.trim_matches(['\0', ' ']), 8).unwrap();
        let end = header[..100]
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(100);
        if &header[..end] == name.as_bytes() {
            return at + TAR_BLOCK..at + TAR_BLOCK + length;
        }
        at += TAR_BLOCK + length.div_ceil(TAR_BLOCK) * TAR_BLOCK;
    }
    panic!("the archive has no entry {name}");
}

fn unique_offset(bytes: &[u8], needle: &[u8]) -> usize {
    let found: Vec<_> = bytes
        .windows(needle.len())
        .enumerate()
        .filter_map(|(at, slice)| (slice == needle).then_some(at))
        .collect();
    assert_eq!(found.len(), 1, "the fixture must contain one match");
    found[0]
}

fn unsigned(bytes: &[u8], cursor: &mut usize) -> usize {
    let tag = bytes[*cursor];
    *cursor += 1;
    let width = match tag {
        0..=127 => return tag as usize,
        0xcc => 1,
        0xcd => 2,
        0xce => 4,
        0xcf => 8,
        _ => panic!("the fixture contains a non-integer tag {tag}"),
    };
    let value = bytes[*cursor..*cursor + width]
        .iter()
        .fold(0usize, |value, byte| (value << 8) | usize::from(*byte));
    *cursor += width;
    value
}

fn consume(bytes: &[u8], cursor: &mut usize, expected: &[u8]) {
    assert_eq!(&bytes[*cursor..*cursor + expected.len()], expected);
    *cursor += expected.len();
}

fn duplicate_id_order(archive: &mut [u8]) {
    let segment = entry_body(archive, "segments/0/s0000000000000000");
    let bytes = &mut archive[segment];
    assert_eq!(bytes[4], 6);
    let previous_checksum: [u8; 4] = bytes[14..18].try_into().unwrap();
    let head_length = u32::from_le_bytes(bytes[32..36].try_into().unwrap()) as usize;
    let head_start = ENVELOPE_BYTES + HEAD_PREFIX_BYTES;
    let head_range = head_start..head_start + head_length;
    let head = &bytes[head_range.clone()];
    let key = b"\xa4name\xa7idOrder\xa6offset";
    let mut cursor = unique_offset(head, key) + key.len();
    let section_start = ENVELOPE_BYTES + unsigned(head, &mut cursor);
    consume(head, &mut cursor, b"\xa6length");
    let section_length = unsigned(head, &mut cursor);
    assert_eq!(section_length, 8);
    consume(head, &mut cursor, b"\xa9pageBytes");
    let page_bytes = unsigned(head, &mut cursor);
    assert!(page_bytes >= section_length);
    consume(head, &mut cursor, b"\xa9checksums\xc4\x04");
    let checksum_at = head_start + cursor;
    let first: [u8; 4] = bytes[section_start..section_start + 4].try_into().unwrap();
    assert_ne!(&bytes[section_start + 4..section_start + 8], &first);
    bytes[section_start + 4..section_start + 8].copy_from_slice(&first);
    let page_crc = crc32fast::hash(&bytes[section_start..section_start + section_length]);
    bytes[checksum_at..checksum_at + 4].copy_from_slice(&page_crc.to_le_bytes());
    let head_crc = crc32fast::hash(&bytes[head_range]);
    bytes[36..40].copy_from_slice(&head_crc.to_le_bytes());
    let payload_crc = crc32fast::hash(&bytes[ENVELOPE_BYTES..]);
    bytes[14..18].copy_from_slice(&payload_crc.to_be_bytes());

    let manifest = entry_body(archive, "manifest");
    let bytes = &mut archive[manifest];
    assert_eq!(u16::from_be_bytes(bytes[12..14].try_into().unwrap()) & 1, 0);
    let checksum_at = ENVELOPE_BYTES + unique_offset(&bytes[ENVELOPE_BYTES..], &previous_checksum);
    assert_eq!(bytes[checksum_at - 1], 0xce);
    bytes[checksum_at..checksum_at + 4].copy_from_slice(&payload_crc.to_be_bytes());
    let manifest_crc = crc32fast::hash(&bytes[ENVELOPE_BYTES..]);
    bytes[14..18].copy_from_slice(&manifest_crc.to_be_bytes());
}

#[test]
fn a_restore_rejects_duplicate_paged_id_ordinals_before_replacing_the_index() {
    let source_root = ScratchDirectory::new("restore-paged-invalid-source");
    let source = Tier::Log.open(source_root.path());
    source.create_index(INDEX, config()).unwrap();
    insert(&source, "alpha");
    insert(&source, "beta");
    let mut archive = snapshot_of(&source, INDEX);
    source.shutdown().unwrap();

    let root = ScratchDirectory::new("restore-paged-invalid-target");
    let target = Tier::Log.open(root.path());
    target.restore(INDEX, &mut archive.as_slice()).unwrap();
    assert!(target.get(INDEX, "alpha").unwrap().is_some());
    assert!(target.get(INDEX, "beta").unwrap().is_some());
    insert(&target, "preserved");
    target.checkpoint(INDEX).unwrap();
    duplicate_id_order(&mut archive);

    let restored = target.restore(INDEX, &mut archive.as_slice());
    if restored.is_ok() {
        let count = target.count_documents(INDEX).unwrap();
        let beta = target.get(INDEX, "beta").unwrap();
        target.shutdown().unwrap();
        assert!(
            beta.is_some(),
            "restore accepted a duplicate ID ordinal: count is {count}, but beta is missing"
        );
    }
    let error = restored.expect_err("the malformed snapshot must be refused");
    assert_eq!(error.code(), ErrorCode::PERSISTENCE_LOAD_FAILED);
    assert!(target.get(INDEX, "preserved").unwrap().is_some());
    target.shutdown().unwrap();
}
