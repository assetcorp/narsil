use std::collections::HashMap;
use std::io::{Read, Write};

use crate::conformance::forms::{form_error, header_from_form, list, object, string};
use crate::conformance::keyword::{read_keyword_segment, write_keyword_segment};
use crate::conformance::manifest::{dead_from_form, read_manifest};
use crate::conformance::mirrored::{read_index_configuration, write_index_configuration};
use crate::conformance::paged::{read_paged_segment, write_paged_segment};
use crate::conformance::vectors::{
    Written, read_graph_part, read_vector_file, write_graph_part, write_vector_file,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive::{
    ARCHIVE_CONFIG_ENTRY, ARCHIVE_MANIFEST_ENTRY, ArchiveSink, ArchiveSource,
    read_snapshot_archive, write_snapshot_archive,
};
use crate::format::envelope::pack;
use crate::format::keyword_segment::KEYWORD_SEGMENT_ENVELOPE_VERSION;
use crate::format::manifest::{
    DecodedManifest, MANIFEST_ENVELOPE_VERSION, SegmentManifest, decode_manifest_payload,
    listed_keys, manifest_to_wire, source_index_name,
};
use crate::format::manifest_refs::FileRef;
use crate::format::paged_segment::PAGED_SEGMENT_ENVELOPE_VERSION;
use crate::value::{Map, Value, encode_value};

const PLACEMENT_KEYS: [&str; 5] = [
    "bytes",
    "checksum",
    "headOffset",
    "headLength",
    "headChecksum",
];
const ENVELOPE_VERSION_OFFSET: usize = 4;
const SEGMENT_ID_DIGITS: usize = 16;

enum EntryKind {
    Segment,
    GraphPart,
    VectorFile,
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn before_numbered_id<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
    let id_start = text.len().checked_sub(SEGMENT_ID_DIGITS)?;
    let id = text.get(id_start..)?;
    if !all_digits(id) {
        return None;
    }
    text[..id_start].strip_suffix(marker)
}

fn is_graph_part(field: &str) -> bool {
    let Some(head) = before_numbered_id(field, "-p") else {
        return false;
    };
    let generation_start = head.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    if generation_start == head.len() {
        return false;
    }
    head[..generation_start]
        .strip_suffix("-graph-g")
        .is_some_and(|name| !name.is_empty())
}

fn entry_kind(name: &str) -> Option<EntryKind> {
    let rest = name.strip_prefix("segments/")?;
    if let Some((partition, segment)) = rest.split_once('/') {
        let id = segment.strip_prefix('s').unwrap_or_default();
        if all_digits(partition) && id.len() == SEGMENT_ID_DIGITS && all_digits(id) {
            return Some(EntryKind::Segment);
        }
    }
    let field = rest.strip_prefix("vec-")?;
    if is_graph_part(field) {
        return Some(EntryKind::GraphPart);
    }
    before_numbered_id(field, "-f")
        .is_some_and(|name| !name.is_empty())
        .then_some(EntryKind::VectorFile)
}

fn vector_storage(config: &Value) -> &'static str {
    let storage = config
        .as_object()
        .and_then(|form| form.get("payload"))
        .and_then(Value::as_object)
        .and_then(|payload| payload.get("vectorPromotion"))
        .and_then(Value::as_object)
        .and_then(|promotion| promotion.get("storage"))
        .and_then(Value::as_str);
    if storage == Some("disk") {
        "disk"
    } else {
        "memory"
    }
}

#[derive(Default)]
struct CollectedArchive {
    config: Vec<u8>,
    manifest: Vec<u8>,
    files: Vec<(String, Vec<u8>)>,
}

impl ArchiveSink for CollectedArchive {
    fn config(&mut self, bytes: Vec<u8>) -> Result<()> {
        self.config = bytes;
        Ok(())
    }

    fn manifest(&mut self, bytes: &[u8], _: &SegmentManifest, _: &str) -> Result<()> {
        self.manifest = bytes.to_vec();
        Ok(())
    }

    fn file(&mut self, entry_name: &str, _: &FileRef, body: &mut dyn Read) -> Result<()> {
        let mut bytes = Vec::new();
        body.read_to_end(&mut bytes).map_err(|error| {
            NarsilError::new(ErrorCode::PERSISTENCE_LOAD_FAILED, error.to_string())
        })?;
        self.files.push((entry_name.to_string(), bytes));
        Ok(())
    }

    fn history(&mut self, _: usize, _: &mut dyn Read) -> Result<()> {
        Ok(())
    }
}

fn ref_maps(payload: &mut Map) -> Vec<&mut Map> {
    let mut refs = Vec::new();
    for (key, value) in payload.iter_mut() {
        let lists: &[&str] = match key.as_str() {
            "partitions" => &["segments"],
            "vectors" => &["files", "graphParts"],
            _ => continue,
        };
        let Value::Array(entries) = value else {
            continue;
        };
        for entry in entries.iter_mut().filter_map(Value::as_object_mut) {
            for (inner, list) in entry.iter_mut() {
                if let (true, Value::Array(files)) = (lists.contains(&inner.as_str()), list) {
                    refs.extend(files.iter_mut().filter_map(Value::as_object_mut));
                }
            }
        }
    }
    refs
}

fn segment_form(bytes: &[u8], kind: &EntryKind, storage: &str) -> Result<Value> {
    match kind {
        EntryKind::GraphPart => read_graph_part(bytes, Some(storage)),
        EntryKind::VectorFile => read_vector_file(bytes, Some(storage)),
        EntryKind::Segment => match bytes.get(ENVELOPE_VERSION_OFFSET) {
            Some(&version) if version == KEYWORD_SEGMENT_ENVELOPE_VERSION => {
                read_keyword_segment(bytes)
            }
            Some(&version) if version == PAGED_SEGMENT_ENVELOPE_VERSION => {
                read_paged_segment(bytes)
            }
            Some(&version) => Err(form_error(format!(
                "the segment holds envelope version {version}"
            ))),
            None => Err(form_error("the segment ends inside its header")),
        },
    }
}

fn named(name: &str, content: Value) -> Value {
    let mut entry = Map::new();
    entry.insert("name", Value::String(name.to_string()));
    entry.insert("content", content);
    Value::Object(entry)
}

pub(crate) fn read_snapshot_archive_form(bytes: &[u8]) -> Result<Value> {
    let mut collected = CollectedArchive::default();
    read_snapshot_archive(&mut &bytes[..], &mut collected)?;
    let config = read_index_configuration(&collected.config)?;
    let storage = vector_storage(&config);
    let mut manifest = read_manifest(&collected.manifest)?;
    if let Some(payload) = manifest
        .as_object_mut()
        .and_then(|form| form.get_mut("payload"))
        .and_then(Value::as_object_mut)
    {
        for file in ref_maps(payload) {
            for key in PLACEMENT_KEYS {
                file.remove(key);
            }
        }
    }
    let mut entries = vec![
        named(ARCHIVE_CONFIG_ENTRY, config),
        named(ARCHIVE_MANIFEST_ENTRY, manifest),
    ];
    for (name, file) in &collected.files {
        let Some(kind) = entry_kind(name) else {
            return Err(form_error(format!(
                "the archive holds an entry named {name}"
            )));
        };
        entries.push(named(name, segment_form(file, &kind, storage)?));
    }
    let mut form = Map::new();
    form.insert("entries", Value::Array(entries));
    Ok(Value::Object(form))
}

fn written_entry(name: &str, content: &Map, storage: &str) -> Result<Written> {
    match entry_kind(name) {
        Some(EntryKind::GraphPart) => write_graph_part(content, Some(storage)),
        Some(EntryKind::VectorFile) => write_vector_file(content, Some(storage)),
        Some(EntryKind::Segment) if !content.contains_key("head") => {
            write_keyword_segment(content).map(|bytes| (bytes, None))
        }
        Some(EntryKind::Segment) => write_paged_segment(content).map(|bytes| (bytes, None)),
        None => Err(form_error(format!(
            "{name} is not a file that an archive lists"
        ))),
    }
}

fn header_checksum(bytes: &[u8]) -> f64 {
    f64::from(u32::from_be_bytes([
        bytes[14], bytes[15], bytes[16], bytes[17],
    ]))
}

pub(crate) fn write_snapshot_archive_form(form: &Map) -> Result<Vec<u8>> {
    let entries = list(form.get("entries"), "entries")?;
    let [config_entry, manifest_entry, file_entries @ ..] = entries else {
        return Err(form_error(
            "an archive must begin with its config and manifest entries",
        ));
    };
    let (config_entry, manifest_entry) = (
        object(Some(config_entry), "config")?,
        object(Some(manifest_entry), "manifest")?,
    );
    if string(config_entry.get("name"), "name")? != ARCHIVE_CONFIG_ENTRY
        || string(manifest_entry.get("name"), "name")? != ARCHIVE_MANIFEST_ENTRY
    {
        return Err(form_error(
            "an archive must begin with its config and manifest entries",
        ));
    }
    let config_form = object(config_entry.get("content"), "config content")?;
    let config = write_index_configuration(config_form)?;
    let storage = vector_storage(&Value::Object(config_form.clone()));
    let manifest_form = object(manifest_entry.get("content"), "manifest content")?;
    let mut payload = object(manifest_form.get("payload"), "manifest payload")?.clone();
    dead_from_form(&mut payload)?;
    let index_name = source_index_name(&listed_keys(&payload))?;
    let mut written: HashMap<String, Vec<u8>> = HashMap::new();
    for entry in file_entries {
        let entry = object(Some(entry), "entry")?;
        let name = string(entry.get("name"), "entry name")?;
        let (bytes, head) = written_entry(&name, object(entry.get("content"), &name)?, storage)?;
        let key = format!("{index_name}/{name}");
        let mut refs = ref_maps(&mut payload);
        let Some(file) = refs
            .iter_mut()
            .find(|file| file.get("key").and_then(Value::as_str) == Some(key.as_str()))
        else {
            return Err(form_error(format!(
                "the archive holds {name}, which its manifest does not list"
            )));
        };
        file.insert("bytes", Value::Number(bytes.len() as f64));
        file.insert("checksum", Value::Number(header_checksum(&bytes)));
        if let Some(head) = head {
            file.insert("headOffset", Value::Number(head.offset as f64));
            file.insert("headLength", Value::Number(f64::from(head.length)));
            file.insert("headChecksum", Value::Number(f64::from(head.checksum)));
        }
        written.insert(key, bytes);
    }
    let DecodedManifest::Current(manifest) = decode_manifest_payload(&payload, &index_name)? else {
        return Err(form_error(
            "the archive's manifest is not a current manifest",
        ));
    };
    let header = header_from_form(manifest_form)?;
    if header.version != MANIFEST_ENVELOPE_VERSION {
        return Err(form_error("a manifest takes envelope format v2"));
    }
    let manifest_bytes = pack(
        &encode_value(&Value::Object(manifest_to_wire(&manifest)))?,
        header.version,
        header.compression,
        "segment manifest",
    )?;
    let source = ArchiveSource {
        config: &config,
        manifest_bytes: &manifest_bytes,
        manifest: &manifest,
        source_index_name: &index_name,
        history: &|| Ok(None),
    };
    let mut out = Vec::new();
    write_snapshot_archive(&mut out, &source, &mut |file, sink: &mut dyn Write| {
        let Some(bytes) = written.get(&file.key) else {
            return Err(form_error(format!(
                "the archive lists {}, which it does not hold",
                file.key
            )));
        };
        sink.write_all(bytes)
            .map_err(|error| form_error(error.to_string()))
    })?;
    Ok(out)
}
