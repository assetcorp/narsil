mod bm25;
mod constants;
mod errors;
mod feed_routes;
mod feed_settings;
mod js_text;
mod partition;
mod range;
mod routes;
mod stream;
mod sync_snapshot;
mod synonyms;
mod vectors;

pub(crate) use feed_routes::handle as handle_feed_settings;
pub(crate) use routes::handle as handle_index_settings;
