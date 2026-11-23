use narsil::{IndexConfig, QuerySuggestionsSource};

use super::super::handle::ClusterNode;
use crate::error::ClusterResult;
use crate::node::CreateIndexOptions;

impl ClusterNode {
    pub(super) async fn create_marked_index(
        &self,
        index_name: &str,
        config: IndexConfig,
        options: CreateIndexOptions,
        source: &QuerySuggestionsSource,
    ) -> ClusterResult<()> {
        self.guard_shutdown()?;
        if let Some(data) = &self.inner.data {
            data.refuse_orphaned_name(index_name)?;
        }
        self.await_torn_down_copy(index_name).await?;
        self.route_create_index(index_name, config, &options, Some(source))
            .await
    }
}
