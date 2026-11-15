use std::sync::Arc;

use crate::errors::{Outcome, ServerError};
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::http::routes::Route;
use crate::state::ServerState;

const CLUSTER_OPERATION_UNSUPPORTED: &str = "CLUSTER_OPERATION_UNSUPPORTED";
const NO_CLUSTER: &str = "This server fronts a single engine, so it reports no cluster";
const NO_CLUSTER_METRICS: &str =
    "This server fronts a single engine, so it reports no cluster metrics";

pub(crate) async fn handle(
    _state: Arc<ServerState>,
    route: Route,
    _context: RouteContext,
) -> Outcome<HttpResponse> {
    let message = if route == Route::Metrics {
        NO_CLUSTER_METRICS
    } else {
        NO_CLUSTER
    };
    Err(ServerError::coded(CLUSTER_OPERATION_UNSUPPORTED, message))
}
