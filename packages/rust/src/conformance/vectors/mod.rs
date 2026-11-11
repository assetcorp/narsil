mod graph_part;
mod vector_file;

use crate::conformance::forms::{HeaderForm, form_error, header_from_form};
use crate::error::Result;
use crate::format::envelope::Compression;
use crate::format::manifest_refs::Head;
use crate::value::{Map, Value, decode_value};

pub(crate) use graph_part::{read_graph_part, write_graph_part};
pub(crate) use vector_file::{read_vector_file, write_vector_file};

pub(crate) type Written = (Vec<u8>, Option<Head>);

fn storage_is_disk(storage: Option<&str>) -> Result<bool> {
    match storage {
        Some("disk") => Ok(true),
        Some("memory") => Ok(false),
        _ => Err(form_error("a vector sample names memory or disk storage")),
    }
}

fn require_disk_keys(payload: &[u8], disk: bool, keys: &[&str]) -> Result<()> {
    if !disk {
        return Ok(());
    }
    let Value::Object(map) = decode_value(payload)? else {
        return Err(form_error("the payload is not a map"));
    };
    match keys.iter().find(|key| !map.contains_key(key)) {
        Some(key) => Err(form_error(format!(
            "the file belongs to a disk field and holds no {key}"
        ))),
        None => Ok(()),
    }
}

fn storage_value(disk: bool) -> Value {
    Value::String(if disk { "disk" } else { "memory" }.to_string())
}

fn checkpoint_header(form: &Map, version: u8, what: &str) -> Result<HeaderForm> {
    let header = header_from_form(form)?;
    if header.version != version || header.compression != Compression::None || !header.checksum {
        return Err(form_error(format!(
            "a {what} takes envelope format v{version}, uncompressed and checksummed"
        )));
    }
    Ok(header)
}
