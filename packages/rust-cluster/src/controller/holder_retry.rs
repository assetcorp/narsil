use std::sync::Arc;
use std::time::Duration;

use super::departures::DepartureRun;
use super::placement::nodes_for_each_index;
use super::{Inner, lock};
use crate::constants::HOLDER_RETRY_CEILING_MS;
use crate::error::ClusterResult;
use crate::transport::BoxFuture;

impl Inner {
    pub(super) fn schedule_holder_retry(self: &Arc<Self>, delay_ms: u64) {
        let sequence = self.next_sequence();
        let mut state = lock(&self.state);
        if let Some((_, previous)) = state.holder_retry.take() {
            previous.abort();
        }
        if state.indexes_awaiting_holders.is_empty() || !self.is_active() {
            return;
        }
        let inner = Arc::clone(self);
        state.holder_retry = Some((
            sequence,
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                {
                    let mut state = lock(&inner.state);
                    if state.holder_retry.as_ref().map(|(queued, _)| *queued) != Some(sequence) {
                        return;
                    }
                    state.holder_retry = None;
                }
                tokio::spawn(inner.ask_again_then_schedule(delay_ms));
            }),
        ));
    }

    fn ask_again_then_schedule(self: Arc<Self>, delay_ms: u64) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            if !self.is_active() {
                return;
            }
            let _ = self.ask_holders_again().await;
            let replaced = lock(&self.state).holder_retry.is_some();
            if !replaced {
                self.schedule_holder_retry(delay_ms.saturating_mul(2).min(HOLDER_RETRY_CEILING_MS));
            }
        })
    }

    async fn ask_holders_again(&self) -> ClusterResult<()> {
        let nodes = self.compatible_nodes().await?;
        let mut waiting: Vec<String> = lock(&self.state)
            .indexes_awaiting_holders
            .iter()
            .cloned()
            .collect();
        waiting.sort();
        let nodes_for = nodes_for_each_index(self.coordinator(), nodes, &waiting).await?;
        let mut departures = DepartureRun::start(nodes_for.every_node());
        for index_name in &waiting {
            if !self.is_active() {
                return Ok(());
            }
            if let Err(error) = self
                .recover_index_partitions(
                    index_name,
                    nodes_for.for_index(index_name),
                    &mut departures,
                )
                .await
            {
                self.report(index_name, &error);
            }
        }
        Ok(())
    }
}
