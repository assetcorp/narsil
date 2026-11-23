use std::sync::Arc;

use narsil::{ListenerId, NarsilEvent, NarsilEventKind};
use tokio::runtime::Handle;

use super::primary_read::PrimaryReads;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::copies::LocalCopies;

pub(in crate::data) struct FeedParts {
    pub(in crate::data) runtime: Handle,
    pub(in crate::data) reads: Arc<PrimaryReads>,
    pub(in crate::data) copies: Option<Arc<LocalCopies>>,
    pub(in crate::data) coordinator: Arc<EtcdCoordinator>,
}

impl FeedParts {
    pub(super) fn listen_to_local_writes(
        &self,
        on_write: impl Fn(&str) + Send + Sync + 'static,
    ) -> Option<ListenerId> {
        let copies = self.copies.as_ref()?;
        Some(copies.engine.on(NarsilEventKind::Write, move |event| {
            if let NarsilEvent::Write { index_name } = event {
                on_write(index_name);
            }
        }))
    }

    pub(super) fn stop_listening(&self, id: ListenerId) {
        if let Some(copies) = &self.copies {
            copies.engine.off(id);
        }
    }
}
