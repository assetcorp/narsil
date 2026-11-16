use narsil_server::ServerLimits;

use super::constants::ENGINE_MAX_RERANK_WINDOW;
use super::variables::{Setting, VariableReader, WholeNumberRange};

const UNBOUNDED_AT_ZERO: u64 = 0;
const COUNTED: u64 = 1;
const MIN_FRACTION: f64 = 0.0;
const MAX_FRACTION: f64 = 1.0;

fn whole(
    reader: &VariableReader<'_>,
    variable: &str,
    min: u64,
    max: Option<u64>,
) -> Setting<Option<u64>> {
    reader.whole_number(variable, WholeNumberRange { min, max })
}

pub fn read_limits(reader: &VariableReader<'_>) -> Setting<ServerLimits> {
    Ok(ServerLimits {
        max_body_bytes: whole(
            reader,
            "NARSIL_LIMIT_MAX_BODY_BYTES",
            UNBOUNDED_AT_ZERO,
            None,
        )?,
        max_import_bytes: whole(
            reader,
            "NARSIL_LIMIT_MAX_IMPORT_BYTES",
            UNBOUNDED_AT_ZERO,
            None,
        )?,
        max_restore_bytes: whole(
            reader,
            "NARSIL_LIMIT_MAX_RESTORE_BYTES",
            UNBOUNDED_AT_ZERO,
            None,
        )?,
        max_line_bytes: whole(
            reader,
            "NARSIL_LIMIT_MAX_LINE_BYTES",
            UNBOUNDED_AT_ZERO,
            None,
        )?,
        import_batch_size: whole(reader, "NARSIL_LIMIT_IMPORT_BATCH_SIZE", COUNTED, None)?,
        max_concurrent_requests: whole(
            reader,
            "NARSIL_LIMIT_MAX_CONCURRENT_REQUESTS",
            UNBOUNDED_AT_ZERO,
            None,
        )?,
        max_body_bytes_in_flight_fraction: reader.decimal(
            "NARSIL_LIMIT_MAX_BODY_BYTES_IN_FLIGHT_FRACTION",
            MIN_FRACTION,
            MAX_FRACTION,
        )?,
        max_result_window: whole(reader, "NARSIL_LIMIT_MAX_RESULT_WINDOW", COUNTED, None)?,
        max_rerank_window: whole(
            reader,
            "NARSIL_LIMIT_MAX_RERANK_WINDOW",
            COUNTED,
            Some(ENGINE_MAX_RERANK_WINDOW),
        )?,
        max_fetch_documents: whole(reader, "NARSIL_LIMIT_MAX_FETCH_DOCUMENTS", COUNTED, None)?,
        max_import_errors: whole(
            reader,
            "NARSIL_LIMIT_MAX_IMPORT_ERRORS",
            UNBOUNDED_AT_ZERO,
            None,
        )?,
        max_task_page_size: whole(reader, "NARSIL_LIMIT_MAX_TASK_PAGE_SIZE", COUNTED, None)?,
        max_concurrent_tasks: whole(
            reader,
            "NARSIL_LIMIT_MAX_CONCURRENT_TASKS",
            UNBOUNDED_AT_ZERO,
            None,
        )?,
    })
}
