use narsil::suggestions_host::{
    HistoryFiles, RemoteFile, RestoredHistoryWriter, SuggestionsService,
};
use tokio::runtime::Handle;
use tokio::sync::mpsc::{Sender, channel};

use super::super::handle::ClusterNode;
use super::NodeSuggestions;
use super::remote_history::{RemoteHistory, RemoteSource};
use crate::backups::{ClusterQueryHistory, HistoryFileReceiver};
use crate::constants::RESTORED_BAN_REMOVAL_BATCH;
use crate::controller::lock;
use crate::data::blocking::off_executor;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::transport::BoxFuture;

const DOC_NOT_FOUND: &str = "DOC_NOT_FOUND";

type FileSender = Sender<ClusterResult<Vec<u8>>>;

fn send_local_files(
    service: &SuggestionsService,
    files: &HistoryFiles,
    index_name: &str,
    sender: &FileSender,
) -> bool {
    service.save_day(index_name);
    let keys = match files.day_file_keys(index_name) {
        Ok(keys) => keys,
        Err(error) => {
            let _ = sender.blocking_send(Err(error.into()));
            return false;
        }
    };
    for key in keys {
        let sent = match files.read(&key) {
            Ok(Some(bytes)) if service.holds_history_of(index_name, &bytes) => {
                sender.blocking_send(Ok(bytes))
            }
            Ok(_) => continue,
            Err(error) => {
                let _ = sender.blocking_send(Err(error.into()));
                return false;
            }
        };
        if sent.is_err() {
            return false;
        }
    }
    true
}

fn send_every_file(
    suggestions: &NodeSuggestions,
    runtime: Handle,
    index_name: &str,
    sender: &FileSender,
) {
    let (Ok(service), Some(files)) = (suggestions.service(), lock(&suggestions.files).clone())
    else {
        return;
    };
    if let Err(error) = runtime.block_on(suggestions.view.refresh(index_name)) {
        let _ = sender.blocking_send(Err(error));
        return;
    }
    if !send_local_files(&service, &files, index_name, sender) {
        return;
    }
    let source = RemoteSource {
        node_id: suggestions.node_id.clone(),
        node: suggestions.node.clone(),
        files,
        runtime,
    };
    for remote in RemoteHistory::new(source, index_name) {
        if let RemoteFile::File { bytes, .. } = remote
            && service.holds_history_of(index_name, &bytes)
            && sender.blocking_send(Ok(bytes)).is_err()
        {
            return;
        }
    }
}

impl NodeSuggestions {
    fn cluster_node(&self) -> ClusterResult<ClusterNode> {
        match self.node.upgrade() {
            Some(inner) => Ok(ClusterNode { inner }),
            None => Err(ClusterError::new(
                codes::NODE_NOT_JOINED,
                format!("Node '{}' has shut down", self.node_id),
            )),
        }
    }

    async fn remove_source_bans(&self, index_name: &str, bans: &[String]) -> ClusterResult<()> {
        let node = self.cluster_node()?;
        for batch in bans.chunks(RESTORED_BAN_REMOVAL_BATCH) {
            let result = node.remove_batch(index_name, batch.to_vec()).await?;
            if let Some(failure) = result
                .failed
                .into_iter()
                .find(|failure| failure.error.code() != DOC_NOT_FOUND)
            {
                return Err(failure.error);
            }
        }
        Ok(())
    }

    async fn restore_finished(&self, index_name: &str) -> ClusterResult<()> {
        let marker = self
            .view
            .refresh(index_name)
            .await?
            .and_then(|index| index.state.source().cloned());
        if let Some(marker) = marker.filter(|marker| marker.index != index_name) {
            let bans = self
                .view
                .refresh(&marker.index)
                .await?
                .map(|index| index.state.banned().to_vec())
                .unwrap_or_default();
            let _ = self.remove_source_bans(index_name, &bans).await;
        }
        let Ok(service) = self.service() else {
            return Ok(());
        };
        let index_name = index_name.to_string();
        off_executor(move || service.setting_changed(&index_name)).await
    }

    async fn restored_writer(
        &self,
        index_name: &str,
    ) -> ClusterResult<Option<RestoredHistoryWriter>> {
        let setting = self
            .view
            .refresh(index_name)
            .await?
            .and_then(|index| index.state.setting().cloned());
        let Ok(service) = self.service() else {
            return Ok(None);
        };
        let index_name = index_name.to_string();
        Ok(off_executor(move || service.restored_history(&index_name, setting.as_ref())).await??)
    }
}

impl ClusterQueryHistory for NodeSuggestions {
    fn each_file(&self, index_name: &str) -> HistoryFileReceiver {
        let (sender, receiver) = channel(1);
        let Some(suggestions) = self.this.upgrade() else {
            return receiver;
        };
        let (runtime, index_name) = (Handle::current(), index_name.to_string());
        tokio::task::spawn_blocking(move || {
            send_every_file(&suggestions, runtime, &index_name, &sender);
        });
        receiver
    }

    fn clear_name<'a>(&'a self, index_name: &'a str) -> BoxFuture<'a, ClusterResult<()>> {
        Box::pin(async move {
            self.cluster_node()?
                .clear_leftovers_of_name(index_name)
                .await
        })
    }

    fn restored_sink<'a>(
        &'a self,
        index_name: &'a str,
    ) -> BoxFuture<'a, ClusterResult<Option<RestoredHistoryWriter>>> {
        Box::pin(self.restored_writer(index_name))
    }

    fn after_restore<'a>(&'a self, index_name: &'a str) -> BoxFuture<'a, ClusterResult<()>> {
        Box::pin(self.restore_finished(index_name))
    }
}
