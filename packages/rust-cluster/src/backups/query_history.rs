use narsil::replication::{BackupManifest, StoredFile};
use narsil::suggestions_host::RestoredHistoryWriter;
use tokio::sync::mpsc::Receiver;

use super::driver_context::BackupDriverContext;
use super::files::{load_checked_bytes, save_small_file, stored_digests};
use crate::data::blocking::off_executor;
use crate::error::ClusterResult;
use crate::transport::BoxFuture;

pub(crate) type HistoryFileReceiver = Receiver<ClusterResult<Vec<u8>>>;

pub(crate) trait ClusterQueryHistory: Send + Sync {
    fn each_file(&self, index_name: &str) -> HistoryFileReceiver;

    fn clear_name<'a>(&'a self, index_name: &'a str) -> BoxFuture<'a, ClusterResult<()>>;

    fn restored_sink<'a>(
        &'a self,
        index_name: &'a str,
    ) -> BoxFuture<'a, ClusterResult<Option<RestoredHistoryWriter>>>;

    fn after_restore<'a>(&'a self, index_name: &'a str) -> BoxFuture<'a, ClusterResult<()>>;
}

pub(crate) async fn back_up_query_history(
    context: &BackupDriverContext,
    index_name: &str,
) -> ClusterResult<Vec<StoredFile>> {
    let Some(query_history) = &context.deps.query_history else {
        return Ok(Vec::new());
    };
    let mut held = context.store.run(stored_digests).await?;
    let mut stored = Vec::new();
    let mut files = query_history.each_file(index_name);
    while let Some(bytes) = files.recv().await {
        let bytes = bytes?;
        context.assert_still_driving()?;
        let (file, kept) = context
            .store
            .run(move |store| {
                let file = save_small_file(store, &bytes, &mut held)?;
                Ok((file, held))
            })
            .await?;
        held = kept;
        stored.push(file);
    }
    Ok(stored)
}

async fn load_restored_file(
    context: &BackupDriverContext,
    manifest: &BackupManifest,
    file: &StoredFile,
) -> ClusterResult<Vec<u8>> {
    context.assert_still_driving()?;
    let (checked, backup_name) = (file.clone(), manifest.name.clone());
    context
        .store
        .run(move |store| load_checked_bytes(store, &checked, &backup_name))
        .await
}

pub(crate) async fn write_restored_history(
    context: &BackupDriverContext,
    manifest: &BackupManifest,
    index_name: &str,
) -> ClusterResult<()> {
    let Some(query_history) = &context.deps.query_history else {
        return Ok(());
    };
    query_history.after_restore(index_name).await?;
    let files = manifest.query_history.as_deref().unwrap_or_default();
    if files.is_empty() {
        return Ok(());
    }
    let Some(mut sink) = query_history.restored_sink(index_name).await? else {
        return Ok(());
    };
    for file in files {
        let bytes = match load_restored_file(context, manifest, file).await {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = off_executor(move || drop(sink)).await;
                return Err(error);
            }
        };
        sink = off_executor(move || sink.add(&mut bytes.as_slice()).map(|()| sink)).await??;
    }
    off_executor(move || sink.commit()).await??;
    Ok(())
}
