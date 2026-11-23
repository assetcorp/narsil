use std::sync::Arc;

use narsil::partitions::PartitionQuery;
use narsil::{Map, Value};

use super::QueryDeps;
use super::payload::{answer, index_name, partition_ids, request_fields, require_held_generation};
use super::refusal::{ServedRead, refuse_unserved_read};
use super::wire_params::{WireParams, wire_params};
use crate::data::blocking::off_executor;
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types};

const PREFLIGHT_PAYLOAD: &str = "PreflightPayload";

pub(super) async fn answer_preflight(
    deps: &QueryDeps<'_>,
    message: &TransportMessage,
) -> ClusterResult<TransportMessage> {
    let fields = request_fields(message, PREFLIGHT_PAYLOAD)?;
    let index_name = index_name(&fields, PREFLIGHT_PAYLOAD)?;
    let partition_ids = partition_ids(&fields)?;
    let WireParams {
        params,
        index_bm25,
        analysis_generation,
        ..
    } = wire_params(fields.get("params"), None)?;
    refuse_unserved_read(
        &deps.view,
        deps.node_id,
        &index_name,
        &partition_ids,
        ServedRead::Query,
    )
    .await?;
    require_held_generation(&index_name, analysis_generation)?;
    let confinement = PartitionQuery {
        partition_ids,
        index_bm25,
        ..PartitionQuery::default()
    };
    let copies = Arc::clone(&deps.copies);
    let counted =
        off_executor(move || copies.preflight_partitions(&index_name, &params, &confinement))
            .await??;
    let mut payload = Map::with_capacity(2);
    payload.insert("count", Value::from(counted.count));
    payload.insert("analysisStale", Value::Bool(counted.analysis_stale));
    answer(
        message,
        message_types::QUERY_PREFLIGHT_RESULT,
        deps.node_id,
        payload,
    )
}
