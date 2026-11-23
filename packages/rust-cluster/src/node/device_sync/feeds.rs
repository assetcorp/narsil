use std::sync::Arc;

use narsil::{ChangeFeed, ChangeSource, ChangesRequest};

use super::settings::not_ready;
use super::{ClusterNode, refuse_hidden_generation};
use crate::constants::CHANGE_CAPTURE_SPEC_VERSION;
use crate::data::SharedFeedSource;
use crate::error::{ClusterError, ClusterResult, codes};

impl ClusterNode {
    /// Returns the source that a server reads for the device feed and the change feed of a cluster index: it reads
    /// each partition from the node that leads it, and it reports each advance and each setting change of the index.
    pub fn feed_source(&self) -> Arc<dyn ChangeSource> {
        match &self.inner.data {
            Some(data) => data.feed_source(),
            None => Arc::new(SharedFeedSource(Arc::default())),
        }
    }

    /// Returns the changes of a cluster index above the request's positions, and then each later change that the
    /// partitions' primaries commit, as [`narsil::Narsil::changes`] does for one engine.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the name is reserved or malformed, with `CHANGES_NOT_READY` where a
    /// registered node follows a specification version below 1.5, and as [`narsil::Narsil::changes`] does.
    pub async fn follow_changes(
        &self,
        index_name: &str,
        request: &ChangesRequest,
    ) -> ClusterResult<ChangeFeed> {
        refuse_hidden_generation(index_name)?;
        let older = self.nodes_below(CHANGE_CAPTURE_SPEC_VERSION).await?;
        if !older.is_empty() {
            return Err(not_ready(
                codes::CHANGES_NOT_READY,
                "keep no history for change capture",
                CHANGE_CAPTURE_SPEC_VERSION,
                older,
                index_name,
            ));
        }
        let (source, name, request) = (self.feed_source(), index_name.to_string(), request.clone());
        tokio::task::spawn_blocking(move || ChangeFeed::follow(source, &name, &request))
            .await
            .map_err(|_| {
                ClusterError::new(
                    codes::INTERNAL_ERROR,
                    "A change feed stopped opening before it finished",
                )
            })?
            .map_err(ClusterError::from)
    }
}
