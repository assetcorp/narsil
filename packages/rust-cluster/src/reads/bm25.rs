use narsil::coordination::validate_query_bm25;
use narsil::{Map, QueryParams, Value};

use super::ReadDeps;
use super::bm25_view::HeldBm25Setting;
use super::query_conversion::{bm25_sets_value, local_params_to_wire};
use crate::error::ClusterResult;
use crate::query::wire_query::WireQuery;

pub(crate) struct Bm25Routing {
    pub(crate) wire: WireQuery,
    pub(crate) carries_bm25: bool,
}

fn routing_under(params: &QueryParams, setting: Option<HeldBm25Setting>) -> Bm25Routing {
    let mut wire = local_params_to_wire(params);
    let Some(setting) = setting else {
        return Bm25Routing {
            wire,
            carries_bm25: bm25_sets_value(params.bm25.as_ref()),
        };
    };
    wire.index_bm25 = Some(setting.bm25.unwrap_or(Value::Object(Map::new())));
    Bm25Routing {
        wire,
        carries_bm25: setting.revision.is_some() || bm25_sets_value(params.bm25.as_ref()),
    }
}

pub(crate) fn held_bm25_routing_for(
    deps: &ReadDeps,
    setting_name: &str,
    params: &QueryParams,
) -> Option<Bm25Routing> {
    if params.bm25.is_some() {
        return None;
    }
    let setting = deps.bm25_view.held(setting_name)?;
    Some(routing_under(params, Some(setting)))
}

pub(crate) async fn bm25_routing_for(
    deps: &ReadDeps,
    setting_name: &str,
    params: &QueryParams,
) -> ClusterResult<Bm25Routing> {
    if let Some(bm25) = &params.bm25
        && let Some(schema) = deps.coordinator.schema(setting_name).await?
    {
        validate_query_bm25(bm25, &schema)?;
    }
    let setting = deps.bm25_view.current(setting_name).await?;
    Ok(routing_under(params, setting))
}
