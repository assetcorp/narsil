use std::sync::Arc;

use narsil::{Map, Value};

use super::QueryDeps;
use super::payload::{answer, index_name, optional_flag, partition_ids, request_fields};
use super::refusal::{ServedRead, refuse_unserved_read};
use crate::data::blocking::off_executor;
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types};

const COUNT_PAYLOAD: &str = "CountPayload";

pub(super) async fn answer_count(
    deps: &QueryDeps<'_>,
    message: &TransportMessage,
) -> ClusterResult<TransportMessage> {
    let fields = request_fields(message, COUNT_PAYLOAD)?;
    let index_name = index_name(&fields, COUNT_PAYLOAD)?;
    let partition_ids = partition_ids(&fields)?;
    let every_copy = optional_flag(fields.get("everyCopy"), "everyCopy", COUNT_PAYLOAD)?;
    if every_copy != Some(true) {
        refuse_unserved_read(
            &deps.view,
            deps.node_id,
            &index_name,
            &partition_ids,
            ServedRead::Query,
        )
        .await?;
    }
    let copies = Arc::clone(&deps.copies);
    let counted = off_executor(move || copies.count_answer(&index_name, &partition_ids)).await??;
    let mut payload = Map::with_capacity(2);
    payload.insert(
        "partitions",
        Value::Array(counted.partitions.into_iter().map(Value::Object).collect()),
    );
    payload.insert("language", Value::String(counted.language));
    answer(
        message,
        message_types::QUERY_COUNT_RESULT,
        deps.node_id,
        payload,
    )
}
