use super::{Written, checkpoint_header, require_disk_keys, storage_is_disk, storage_value};
use crate::conformance::forms::{
    f32s, f64s, form_error, header_form, list, numbers_form, object, u8s, u32_of,
};
use crate::error::Result;
use crate::format::envelope::{Expectation, open_checksummed, pack};
use crate::format::vector_file::{
    DiskColumns, OSQ_RECORD_TAIL_BYTES, VECTOR_FILE_ENVELOPE_VERSION, VectorCodes, VectorFile,
    decode_vector_file, encode_vector_file, osq_code_bytes, osq_record_bytes,
};
use crate::util::bytes::{f32_bytes, f64_bytes, u32_bytes};
use crate::value::{Map, Value, encode_value};

fn little_endian_f32(bytes: &[u8], at: usize) -> f64 {
    f64::from(f32::from_le_bytes([
        bytes[at],
        bytes[at + 1],
        bytes[at + 2],
        bytes[at + 3],
    ]))
}

fn records_form(codes: &VectorCodes, dimension: usize) -> Value {
    let code_bytes = osq_code_bytes(dimension, codes.bits);
    let record_bytes = code_bytes + OSQ_RECORD_TAIL_BYTES;
    let records = codes
        .records
        .chunks_exact(record_bytes)
        .map(|record| {
            let tail = code_bytes;
            let mut map = Map::new();
            map.insert("code", numbers_form(&record[..tail]));
            map.insert("lower", Value::Number(little_endian_f32(record, tail)));
            map.insert("upper", Value::Number(little_endian_f32(record, tail + 4)));
            map.insert(
                "correction",
                Value::Number(little_endian_f32(record, tail + 8)),
            );
            let sum = u32::from_le_bytes([
                record[tail + 12],
                record[tail + 13],
                record[tail + 14],
                record[tail + 15],
            ]);
            map.insert("sum", Value::Number(f64::from(sum)));
            Value::Object(map)
        })
        .collect();
    Value::Array(records)
}

fn vector_file_form(file: &VectorFile) -> Map {
    let mut payload = Map::new();
    payload.insert("v", Value::Number(1.0));
    payload.insert("fieldName", Value::String(file.field_name.clone()));
    payload.insert("dimension", Value::Number(file.dimension as f64));
    payload.insert(
        "docIds",
        Value::Array(
            file.doc_ids
                .iter()
                .map(|id| Value::String(id.clone()))
                .collect(),
        ),
    );
    let codes = match &file.codes {
        None => Value::Null,
        Some(codes) => {
            let mut map = Map::new();
            map.insert("bits", Value::Number(f64::from(codes.bits)));
            map.insert("centroid", numbers_form(&codes.centroid));
            map.insert("records", records_form(codes, file.dimension));
            Value::Object(map)
        }
    };
    payload.insert("codes", codes);
    if let Some(disk) = &file.disk {
        payload.insert("magnitudes", numbers_form(&disk.magnitudes));
        payload.insert("idOrder", numbers_form(&disk.id_order));
    }
    let vectors = file
        .vectors
        .chunks(file.dimension)
        .map(numbers_form)
        .collect();
    payload.insert("vectors", Value::Array(vectors));
    payload
}

pub(crate) fn read_vector_file(bytes: &[u8], storage: Option<&str>) -> Result<Value> {
    let disk = storage_is_disk(storage)?;
    let expected = Expectation {
        version: VECTOR_FILE_ENVELOPE_VERSION,
        what: "vector file",
        allows_compression: false,
    };
    let (header, payload) = open_checksummed(bytes, &expected)?;
    let file = decode_vector_file(payload.bytes())?;
    require_disk_keys(
        payload.bytes(),
        disk,
        &["magnitudes", "idOffsets", "idOrder", "head"],
    )?;
    let mut form = Map::new();
    form.insert("header", header_form(&header));
    form.insert("storage", storage_value(disk));
    form.insert("payload", Value::Object(vector_file_form(&file)));
    Ok(Value::Object(form))
}

fn records_bytes(records: &[Value], dimension: usize, bits: u8) -> Result<Vec<u8>> {
    let code_bytes = osq_code_bytes(dimension, bits);
    let mut bytes = Vec::with_capacity(records.len() * osq_record_bytes(dimension, bits));
    for (at, record) in records.iter().enumerate() {
        let what = format!("payload.codes.records[{at}]");
        let record = object(Some(record), &what)?;
        let code = u8s(record.get("code"), &format!("{what}.code"))?;
        if code.len() != code_bytes {
            return Err(form_error(format!(
                "{what}.code holds {} bytes",
                code.len()
            )));
        }
        bytes.extend_from_slice(&code);
        for key in ["lower", "upper", "correction"] {
            let value = record.get(key).and_then(Value::as_f64);
            let Some(number) = value else {
                return Err(form_error(format!("{what}.{key} is not a number")));
            };
            bytes.extend_from_slice(&(number as f32).to_le_bytes());
        }
        bytes.extend_from_slice(&u32_of(record.get("sum"), &format!("{what}.sum"))?.to_le_bytes());
    }
    Ok(bytes)
}

fn vector_file_raw(payload: &Map, disk: bool) -> Result<Map> {
    let dimension = u32_of(payload.get("dimension"), "payload.dimension")? as usize;
    let mut vectors = Vec::new();
    for (at, vector) in list(payload.get("vectors"), "payload.vectors")?
        .iter()
        .enumerate()
    {
        vectors.extend(f32s(Some(vector), &format!("payload.vectors[{at}]"))?);
    }
    let mut raw = Map::new();
    for key in ["v", "fieldName", "dimension", "docIds"] {
        raw.insert(key, payload.get(key).cloned().unwrap_or(Value::Null));
    }
    let codes = match payload.get("codes") {
        None | Some(Value::Null) => Value::Null,
        Some(codes) => {
            let codes = object(Some(codes), "payload.codes")?;
            let bits = u32_of(codes.get("bits"), "payload.codes.bits")?;
            let bits = u8::try_from(bits)
                .map_err(|_| form_error("payload.codes.bits is not 8, 4, 2, or 1"))?;
            let records = records_bytes(
                list(codes.get("records"), "payload.codes.records")?,
                dimension,
                bits,
            )?;
            let mut map = Map::new();
            map.insert("bits", Value::Number(f64::from(bits)));
            map.insert(
                "centroid",
                codes.get("centroid").cloned().unwrap_or(Value::Null),
            );
            map.insert("records", Value::Bytes(records));
            Value::Object(map)
        }
    };
    raw.insert("codes", codes);
    if disk || payload.contains_key("magnitudes") {
        let magnitudes = f64s(payload.get("magnitudes"), "payload.magnitudes")?;
        raw.insert("magnitudes", Value::Bytes(f64_bytes(&magnitudes)));
        let count = magnitudes.len() as u32;
        raw.insert(
            "idOrder",
            Value::Bytes(u32_bytes(&(0..count).collect::<Vec<u32>>())),
        );
    }
    raw.insert("vectors", Value::Bytes(f32_bytes(&vectors)));
    Ok(raw)
}

pub(crate) fn write_vector_file(form: &Map, storage: Option<&str>) -> Result<Written> {
    let disk = storage_is_disk(storage)?;
    let header = checkpoint_header(form, VECTOR_FILE_ENVELOPE_VERSION, "vector file")?;
    let raw = vector_file_raw(object(form.get("payload"), "payload")?, disk)?;
    let mut file = decode_vector_file(&encode_value(&Value::Object(raw))?)?;
    if let Some(columns) = file.disk.take() {
        file.disk = Some(DiskColumns {
            magnitudes: columns.magnitudes,
            id_order: Vec::new(),
        });
    }
    let (payload, head) = encode_vector_file(&file)?;
    let bytes = pack(&payload, header.version, header.compression, "vector file")?;
    Ok((bytes, head))
}
