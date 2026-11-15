use std::sync::Arc;

use crate::errors::Outcome;
use crate::http::pipeline::RouteContext;
use crate::http::respond::HttpResponse;
use crate::http::routes::Route;
use crate::maintenance;
use crate::state::ServerState;

pub(crate) async fn handle(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::ImportNdjson => maintenance::import_ndjson(state, context).await,
        Route::RebuildAnalysis => maintenance::rebuild_analysis(state, context).await,
        Route::ChangeAnalysis => maintenance::change_analysis(state, context).await,
        Route::Optimize => maintenance::optimize(state, context).await,
        Route::Rebalance => maintenance::rebalance(state, context).await,
        Route::Restore => maintenance::restore(state, context).await,
        Route::ImportExport => maintenance::import_export(state, context).await,
        _ => maintenance::build_query_suggestions(state, context).await,
    }
}
