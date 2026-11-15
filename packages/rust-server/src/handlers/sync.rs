use std::sync::Arc;

use crate::errors::Outcome;
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::http::routes::Route;
use crate::settings::handle_feed_settings;
use crate::state::ServerState;

pub(crate) async fn handle(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    handle_feed_settings(state, route, context).await
}
