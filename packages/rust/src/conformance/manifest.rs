use crate::conformance::forms::{
    form_error, header_form, header_from_form, numbers_form, object, u8s,
};
use crate::error::Result;
use crate::format::envelope::{pack, read_header};
use crate::format::manifest::{
    DecodedManifest, MANIFEST_ENVELOPE_VERSION, decode_manifest_file, decode_manifest_payload,
    listed_keys, manifest_to_wire, source_index_name,
};
use crate::value::{Map, Value, encode_value};

fn map_dead(payload: &mut Map, convert: &dyn Fn(&Value) -> Result<Value>) -> Result<()> {
    let Some(Value::Array(fields)) = payload.get_mut("vectors") else {
        return Ok(());
    };
    for field in fields {
        let Some(Value::Array(files)) = field.as_object_mut().and_then(|map| map.get_mut("files"))
        else {
            continue;
        };
        for file in files {
            let Some(map) = file.as_object_mut() else {
                continue;
            };
            if let Some(dead) = map.get("dead") {
                let converted = convert(dead)?;
                map.insert("dead", converted);
            }
        }
    }
    Ok(())
}

fn dead_to_form(payload: &mut Map) -> Result<()> {
    map_dead(payload, &|dead| match dead {
        Value::Bytes(bytes) => Ok(numbers_form(bytes)),
        other => Ok(other.clone()),
    })
}

pub(crate) fn dead_from_form(payload: &mut Map) -> Result<()> {
    map_dead(payload, &|dead| match dead {
        Value::Array(_) => Ok(Value::Bytes(u8s(Some(dead), "dead")?)),
        other => Ok(other.clone()),
    })
}

pub(crate) fn read_manifest(bytes: &[u8]) -> Result<Value> {
    let header = read_header(bytes)?;
    let (_, _, decoded) = decode_manifest_file(bytes)?;
    let mut payload = match decoded {
        DecodedManifest::Current(manifest) => manifest_to_wire(&manifest),
        DecodedManifest::Earlier(raw) => raw,
    };
    dead_to_form(&mut payload)?;
    let mut form = Map::new();
    form.insert("header", header_form(&header));
    form.insert("payload", Value::Object(payload));
    Ok(Value::Object(form))
}

pub(crate) fn write_manifest(form: &Map) -> Result<Vec<u8>> {
    let header = header_from_form(form)?;
    if header.version != MANIFEST_ENVELOPE_VERSION {
        return Err(form_error("a manifest takes envelope format v2"));
    }
    let mut payload = object(form.get("payload"), "payload")?.clone();
    dead_from_form(&mut payload)?;
    let index_name = source_index_name(&listed_keys(&payload))?;
    let wire = match decode_manifest_payload(&payload, &index_name)? {
        DecodedManifest::Current(manifest) => manifest_to_wire(&manifest),
        DecodedManifest::Earlier(raw) => raw,
    };
    pack(
        &encode_value(&Value::Object(wire))?,
        header.version,
        header.compression,
        "segment manifest",
    )
}
