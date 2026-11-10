use std::collections::HashMap;

use crate::error::{Result, load_failed};
use crate::schema::require_valid_field_types;
use crate::value::{Decoder, MAX_ENCODING_DEPTH, Map, Value, number_to_text};

const PREFIX: &str = "Invalid partition payload: ";
const LARGEST_ARRAY_INDEX: u64 = 4_294_967_294;
const TOP_LEVEL_DEPTH: usize = 1;
const MIN_ENTRY_BYTES: usize = 2;

/// The stored documents of one version 2 partition payload, as engine 0.3.0 wrote it, with the flat schema
/// that the payload carries.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V2Documents {
    /// The flat schema of the payload, which maps each dotted field path to its type name.
    pub(crate) schema: Map,
    /// Each document ID with its stored fields, in the order that the reference reader walks them, with every
    /// vector field value removed.
    pub(crate) documents: Vec<(String, Map)>,
}

enum ListedDocuments {
    Absent,
    Listed(Vec<(String, Value)>),
    NotAMap,
}

fn starts_map(marker: u8) -> bool {
    matches!(marker, 0x80..=0x8f | 0xde | 0xdf)
}

fn starts_array(marker: u8) -> bool {
    matches!(marker, 0x90..=0x9f | 0xdc | 0xdd)
}

fn read_key(decoder: &mut Decoder<'_>) -> Result<String> {
    let marker = decoder.peek()?;
    if matches!(marker, 0xa0..=0xbf | 0xd9..=0xdb) {
        return Ok(decoder.read_str()?.to_string());
    }
    match decoder.read_number() {
        Ok(number) => Ok(number_to_text(number)),
        Err(_) => load_failed(
            "The MessagePack data is malformed: a map key is neither a string nor a number",
        ),
    }
}

fn skip_value(decoder: &mut Decoder<'_>, depth: usize) -> Result<()> {
    if depth > MAX_ENCODING_DEPTH {
        return load_failed(format!(
            "The MessagePack data is malformed: a value nests deeper than {MAX_ENCODING_DEPTH} levels"
        ));
    }
    let marker = decoder.peek()?;
    if starts_array(marker) {
        for _ in 0..decoder.read_array_length()? {
            skip_value(decoder, depth + 1)?;
        }
        return Ok(());
    }
    if starts_map(marker) {
        for _ in 0..decoder.read_map_length()? {
            read_key(decoder)?;
            skip_value(decoder, depth + 1)?;
        }
        return Ok(());
    }
    decoder.read_value(depth).map(drop)
}

fn array_index_of(key: &str) -> Option<u64> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes.first() == Some(&b'0') {
        return None;
    }
    let value = key.parse::<u64>().ok()?;
    (value <= LARGEST_ARRAY_INDEX).then_some(value)
}

fn read_documents(decoder: &mut Decoder<'_>, total_bytes: usize) -> Result<ListedDocuments> {
    let marker = decoder.peek()?;
    if marker == 0xc0 {
        decoder.read_nil()?;
        return Ok(ListedDocuments::Absent);
    }
    if !starts_map(marker) {
        skip_value(decoder, TOP_LEVEL_DEPTH + 1)?;
        return Ok(ListedDocuments::NotAMap);
    }
    let length = decoder.read_map_length()?;
    let room = length.min(total_bytes.saturating_sub(decoder.position()) / MIN_ENTRY_BYTES);
    let mut listed: Vec<(String, Value)> = Vec::with_capacity(room);
    let mut place: HashMap<String, usize> = HashMap::with_capacity(room);
    for _ in 0..length {
        let id = read_key(decoder)?;
        let value = decoder.read_value(TOP_LEVEL_DEPTH + 2)?;
        match place.get(&id).and_then(|&at| listed.get_mut(at)) {
            Some(entry) => entry.1 = value,
            None => {
                place.insert(id.clone(), listed.len());
                listed.push((id, value));
            }
        }
    }
    listed.sort_by_key(|(id, _)| array_index_of(id).unwrap_or(u64::MAX));
    Ok(ListedDocuments::Listed(listed))
}

fn is_vector_type(type_value: &Value) -> bool {
    let Some(name) = type_value.as_str() else {
        return false;
    };
    name.strip_prefix("vector[")
        .and_then(|rest| rest.strip_suffix(']'))
        .is_some_and(|digits| {
            !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn remove_field_at_path(fields: &mut Map, path: &str) {
    let Some((parents, leaf)) = path.rsplit_once('.') else {
        fields.remove(path);
        return;
    };
    let mut current = fields;
    for segment in parents.split('.') {
        let Some(Value::Object(next)) = current.get_mut(segment) else {
            return;
        };
        current = next;
    }
    current.remove(leaf);
}

fn stored_fields(id: &str, document: Value) -> Result<Map> {
    if let Value::Object(mut document) = document
        && let Some(Value::Object(fields)) = document.remove("fields")
    {
        return Ok(fields);
    }
    load_failed(format!(
        "{PREFIX}document \"{id}\" must be a map that holds a map of fields"
    ))
}

/// Reads the schema and the stored documents of a version 2 partition payload, which engine 0.3.0 wrote into
/// every segment file and snapshot, and removes each vector field value from the stored documents.
///
/// The reader walks the payload without building the inverted index or the field indexes, so its time grows
/// with the size of the payload alone. It raises `SCHEMA_INVALID_TYPE` for a schema that names an unknown type,
/// and `PERSISTENCE_LOAD_FAILED` for a payload that is not a map, a schema or a document list that is not a
/// map, or a document without a map of fields.
pub(crate) fn decode_v2_documents(bytes: &[u8]) -> Result<V2Documents> {
    let mut decoder = Decoder::new(bytes);
    if !starts_map(decoder.peek()?) {
        return load_failed(format!("{PREFIX}payload must be a map"));
    }
    let mut schema = None;
    let mut documents = ListedDocuments::Absent;
    for _ in 0..decoder.read_map_length()? {
        match read_key(&mut decoder)?.as_str() {
            "schema" => schema = Some(decoder.read_value(TOP_LEVEL_DEPTH + 1)?),
            "documents" => documents = read_documents(&mut decoder, bytes.len())?,
            _ => skip_value(&mut decoder, TOP_LEVEL_DEPTH + 1)?,
        }
    }
    if !decoder.is_finished() {
        return load_failed("The MessagePack data is malformed: bytes follow the value");
    }
    let schema = match schema {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(map)) => map,
        Some(_) => return load_failed(format!("{PREFIX}schema must be a map")),
    };
    require_valid_field_types(&schema)?;
    let listed = match documents {
        ListedDocuments::Absent => Vec::new(),
        ListedDocuments::Listed(listed) => listed,
        ListedDocuments::NotAMap => {
            return load_failed(format!("{PREFIX}documents must be a map"));
        }
    };
    let vector_paths: Vec<&str> = schema
        .iter()
        .filter(|(_, type_value)| is_vector_type(type_value))
        .map(|(path, _)| path.as_str())
        .collect();
    let mut out = Vec::with_capacity(listed.len());
    for (id, document) in listed {
        let mut fields = stored_fields(&id, document)?;
        for path in &vector_paths {
            remove_field_at_path(&mut fields, path);
        }
        out.push((id, fields));
    }
    Ok(V2Documents {
        schema,
        documents: out,
    })
}
