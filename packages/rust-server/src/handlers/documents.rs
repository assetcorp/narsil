use std::sync::Arc;

use crate::errors::{Outcome, ServerError};
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::http::routes::Route;
use crate::state::ServerState;

pub(crate) async fn handle(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    let _ = (state, route, context);
    Err(ServerError::internal())
}
