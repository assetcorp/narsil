use std::sync::{Arc, Mutex};

use super::feed_parts::FeedParts;
use super::feed_source::ClusterFeedSource;
use super::primary_read::PrimaryReads;
use super::shared_source::SharedFeedSource;
use super::snapshots::DeviceSnapshots;
use super::view::DeviceSyncView;
use crate::backups::BackupStore;
use crate::constants::DEVICE_SYNC_SPOOL_DIRECTORY;
use crate::controller::lock;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::DataRole;
use crate::data::spool_directory::SpoolDirectory;
use crate::data::writes::AllocationView;
use crate::error::ClusterResult;
use crate::node::{NodeErrorHandler, not_ready};
use crate::transport::NodeTransport;

pub(crate) struct DeviceSyncService {
    node_id: String,
    coordinator: Arc<EtcdCoordinator>,
    on_error: Option<NodeErrorHandler>,
    feed: Arc<ClusterFeedSource>,
    snapshots: Arc<DeviceSnapshots>,
    view: tokio::sync::Mutex<Option<Arc<DeviceSyncView>>>,
    spool: Mutex<Option<SpoolDirectory>>,
}

impl DeviceSyncService {
    pub(crate) fn new(
        node_id: String,
        coordinator: Arc<EtcdCoordinator>,
        store: Option<BackupStore>,
        on_error: Option<NodeErrorHandler>,
    ) -> DeviceSyncService {
        let feed: Arc<ClusterFeedSource> = Arc::default();
        let snapshots = Arc::new(DeviceSnapshots::new(
            Arc::clone(&feed),
            store,
            on_error.clone(),
        ));
        DeviceSyncService {
            node_id,
            coordinator,
            on_error,
            feed,
            snapshots,
            view: tokio::sync::Mutex::new(None),
            spool: Mutex::new(None),
        }
    }

    pub(crate) async fn attach(
        &self,
        transport: Arc<dyn NodeTransport>,
        routing: Arc<AllocationView>,
        data: Option<&DataRole>,
    ) -> ClusterResult<()> {
        let (copies, writes) = match data {
            Some(data) => (Some(data.settled_copies()?), Some(data.primary_writes()?)),
            None => (None, None),
        };
        let spool_root = match &copies {
            Some(copies) => copies.spool.path().to_path_buf(),
            None => {
                let spool = SpoolDirectory::open(None)?;
                let path = spool.path().to_path_buf();
                *lock(&self.spool) = Some(spool);
                path
            }
        };
        self.snapshots
            .place_spool(spool_root.join(DEVICE_SYNC_SPOOL_DIRECTORY));
        let view = Arc::new(DeviceSyncView::new(
            Arc::clone(&self.coordinator),
            copies.clone(),
            self.on_error.clone(),
        ));
        let mut held = self.view.lock().await;
        if let Some(previous) = held.replace(Arc::clone(&view)) {
            self.feed.detach();
            previous.stop().await;
        }
        view.start().await?;
        self.feed.attach(FeedParts {
            runtime: tokio::runtime::Handle::current(),
            reads: Arc::new(PrimaryReads {
                node_id: self.node_id.clone(),
                transport,
                writes,
                routing,
                view,
            }),
            copies,
            coordinator: Arc::clone(&self.coordinator),
        });
        Ok(())
    }

    pub(crate) async fn close(&self) {
        self.feed.detach();
        self.snapshots.close().await;
        let view = self.view.lock().await.take();
        if let Some(view) = view {
            view.stop().await;
        }
        lock(&self.spool).take();
    }

    pub(crate) fn feed_source(&self) -> Arc<SharedFeedSource> {
        Arc::new(SharedFeedSource(
            Arc::clone(&self.feed),
            Some(Arc::clone(&self.snapshots)),
        ))
    }

    pub(crate) fn snapshots(&self) -> &DeviceSnapshots {
        &self.snapshots
    }

    pub(crate) async fn view(&self) -> ClusterResult<Arc<DeviceSyncView>> {
        self.view
            .lock()
            .await
            .clone()
            .ok_or_else(|| not_ready(&self.node_id))
    }

    pub(crate) async fn refresh(&self, index_name: &str) -> ClusterResult<()> {
        let view = self.view.lock().await.clone();
        match view {
            Some(view) => view.refresh(index_name).await,
            None => Ok(()),
        }
    }
}
