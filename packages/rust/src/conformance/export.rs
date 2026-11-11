use crate::conformance::forms::{form_error, list, object};
use crate::error::Result;
use crate::format::document_export::{
    ExportLines, ExportPositions, MAX_EXPORT_LINE_BYTES, document_line, document_of_line,
    header_configuration, header_line,
};
use crate::value::{MAX_SAFE_INTEGER, Map, Value, parse_json_raw};

pub(crate) fn read_document_export(bytes: &[u8]) -> Result<Value> {
    let mut lines = ExportLines::new(bytes, MAX_EXPORT_LINE_BYTES);
    let read_failed = |error: std::io::Error| form_error(error.to_string());
    let header = lines.next().transpose().map_err(read_failed)?;
    header_configuration(header.as_ref())?;
    let header_text = match header.map(|line| line.text) {
        Some(Ok(text)) => text,
        _ => return Err(form_error("the export holds no header")),
    };
    let mut documents = Vec::new();
    for line in lines {
        if let Some((_, document)) = document_of_line(&line.map_err(read_failed)?)? {
            documents.push(Value::Object(document));
        }
    }
    let mut form = Map::new();
    form.insert("header", parse_json_raw(&header_text)?);
    form.insert("documents", Value::Array(documents));
    Ok(Value::Object(form))
}

fn whole_number(value: Option<&Value>, path: &str) -> Result<u64> {
    match value.and_then(Value::as_f64) {
        Some(number)
            if number >= 0.0 && number.fract() == 0.0 && number <= MAX_SAFE_INTEGER as f64 =>
        {
            Ok(number as u64)
        }
        _ => Err(form_error(format!("{path} is not a whole number"))),
    }
}

fn export_positions(header: &Map) -> Result<Option<ExportPositions>> {
    let Some(epoch) = header.get("epoch") else {
        return Ok(None);
    };
    let Some(epoch) = epoch.as_str() else {
        return Err(form_error("header.epoch is not a string"));
    };
    let mut positions = Vec::new();
    for (at, position) in list(header.get("positions"), "header.positions")?
        .iter()
        .enumerate()
    {
        let path = format!("header.positions[{at}]");
        let position = object(Some(position), &path)?;
        let partition_id =
            whole_number(position.get("partitionId"), &format!("{path}.partitionId"))?;
        let partition_id = u32::try_from(partition_id)
            .map_err(|_| form_error(format!("{path}.partitionId passes the partition limit")))?;
        positions.push((
            partition_id,
            whole_number(position.get("seqNo"), &format!("{path}.seqNo"))?,
        ));
    }
    Ok(Some(ExportPositions {
        epoch: epoch.to_string(),
        positions,
    }))
}

pub(crate) fn write_document_export(form: &Map) -> Result<Vec<u8>> {
    let header = object(form.get("header"), "header")?;
    let configuration = object(header.get("index"), "header.index")?;
    let mut text = header_line(configuration, export_positions(header)?.as_ref())?;
    for (at, document) in list(form.get("documents"), "documents")?.iter().enumerate() {
        let document = object(Some(document), &format!("documents[{at}]"))?;
        let Some(Value::String(id)) = document.get("id") else {
            return Err(form_error(format!("documents[{at}] holds no string id")));
        };
        text.push_str(&document_line(id, document)?);
    }
    Ok(text.into_bytes())
}
