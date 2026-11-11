mod archive;
mod columns;
mod earlier;
mod export;
mod forms;
mod keyword;
mod logs;
mod manifest;
mod mirrored;
mod paged;
mod vectors;

use crate::error::Result;
use crate::value::Value;
use forms::form_error;

/// Reads a file that engine 0.3.0 wrote, of the layout `layout`, which is `segment-file`, `snapshot-bundle`, or
/// `index-snapshot`, and returns what a reader recovers from it as JSON: the stored documents of each partition,
/// the parts of each vector field, and each numbered graph.
#[doc(hidden)]
pub fn read_earlier_file(layout: &str, bytes: &[u8]) -> Result<Value> {
    earlier::read_earlier_file(layout, bytes)
}

/// Reads a sample file of the conformance kind `kind`, such as `keyword-segment`, and returns its JSON form.
pub fn read_sample(kind: &str, bytes: &[u8], storage: Option<&str>) -> Result<Value> {
    match kind {
        "vector-file" => vectors::read_vector_file(bytes, storage),
        "graph-part" => vectors::read_graph_part(bytes, storage),
        "snapshot-archive" => archive::read_snapshot_archive_form(bytes),
        "document-export" => export::read_document_export(bytes),
        "keyword-segment" => keyword::read_keyword_segment(bytes),
        "paged-segment" => paged::read_paged_segment(bytes),
        "index-metadata" => mirrored::read_index_metadata(bytes),
        "index-configuration" => mirrored::read_index_configuration(bytes),
        "backup-manifest" => mirrored::read_backup_manifest(bytes),
        "log-segment" => logs::read_log_segment(bytes),
        "commit-marker" => logs::read_commit_marker_form(bytes),
        "manifest" => manifest::read_manifest(bytes),
        other => Err(form_error(format!(
            "this crate reads no {other} sample yet"
        ))),
    }
}

/// Writes a file of the conformance kind `kind` from its JSON form.
pub fn write_sample(kind: &str, form: &Value, storage: Option<&str>) -> Result<Vec<u8>> {
    let Value::Object(map) = form else {
        return Err(form_error("the form is not an object"));
    };
    match kind {
        "vector-file" => vectors::write_vector_file(map, storage).map(|(bytes, _)| bytes),
        "graph-part" => vectors::write_graph_part(map, storage).map(|(bytes, _)| bytes),
        "snapshot-archive" => archive::write_snapshot_archive_form(map),
        "document-export" => export::write_document_export(map),
        "keyword-segment" => keyword::write_keyword_segment(map),
        "paged-segment" => paged::write_paged_segment(map),
        "index-metadata" => mirrored::write_index_metadata(map),
        "index-configuration" => mirrored::write_index_configuration(map),
        "backup-manifest" => mirrored::write_backup_manifest(map),
        "log-segment" => logs::write_log_segment(map),
        "commit-marker" => logs::write_commit_marker_form(map),
        "manifest" => manifest::write_manifest(map),
        other => Err(form_error(format!(
            "this crate writes no {other} sample yet"
        ))),
    }
}
