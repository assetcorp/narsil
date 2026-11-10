use crate::conformance::forms::{form_error, header_form, header_from_form, object};
use crate::error::Result;
use crate::format::backup_manifest::{
    backup_manifest_from_wire, backup_manifest_to_wire, decode_backup_manifest,
    encode_backup_manifest,
};
use crate::format::envelope::{Compression, read_header};
use crate::format::index_configuration::{
    decode_index_configuration, encode_index_configuration, require_configuration_shape,
};
use crate::format::metadata::{
    METADATA_ENVELOPE_VERSION, metadata_from_wire, metadata_to_wire, pack_lenient_envelope,
    read_metadata_file,
};
use crate::value::{Map, Value, encode_value};

const BACKUP_NAME: &str = "conformance";

fn form(header: Value, payload: Value) -> Value {
    let mut map = Map::new();
    map.insert("header", header);
    map.insert("payload", payload);
    Value::Object(map)
}

pub(crate) fn read_index_metadata(bytes: &[u8]) -> Result<Value> {
    let (header, metadata) = read_metadata_file(bytes)?;
    Ok(form(
        header_form(&header),
        Value::Object(metadata_to_wire(&metadata)),
    ))
}

pub(crate) fn write_index_metadata(form: &Map) -> Result<Vec<u8>> {
    let header = header_from_form(form)?;
    if header.version > METADATA_ENVELOPE_VERSION {
        return Err(form_error(
            "an index metadata file takes envelope format v1",
        ));
    }
    let metadata = metadata_from_wire(object(form.get("payload"), "payload")?)?;
    let payload = encode_value(&Value::Object(metadata_to_wire(&metadata)))?;
    pack_lenient_envelope(
        &payload,
        header.version,
        header.compression,
        header.checksum,
    )
}

pub(crate) fn read_index_configuration(bytes: &[u8]) -> Result<Value> {
    let header = read_header(bytes)?;
    let (_, configuration) = decode_index_configuration(bytes)?;
    Ok(form(header_form(&header), Value::Object(configuration)))
}

pub(crate) fn write_index_configuration(form: &Map) -> Result<Vec<u8>> {
    let header = header_from_form(form)?;
    let payload = form.get("payload").cloned().unwrap_or(Value::Null);
    let configuration = require_configuration_shape(&payload, "index configuration")?;
    encode_index_configuration(&configuration, header.compression)
}

pub(crate) fn read_backup_manifest(bytes: &[u8]) -> Result<Value> {
    let header = read_header(bytes)?;
    let manifest = decode_backup_manifest(bytes, BACKUP_NAME)?;
    Ok(form(
        header_form(&header),
        backup_manifest_to_wire(&manifest),
    ))
}

pub(crate) fn write_backup_manifest(form: &Map) -> Result<Vec<u8>> {
    let header = header_from_form(form)?;
    if header.compression != Compression::None {
        return Err(form_error("a backup manifest is never compressed"));
    }
    let payload = form.get("payload").cloned().unwrap_or(Value::Null);
    let manifest = backup_manifest_from_wire(&payload, BACKUP_NAME)?;
    encode_backup_manifest(&manifest)
}
