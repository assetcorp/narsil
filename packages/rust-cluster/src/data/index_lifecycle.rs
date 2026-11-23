use narsil::held_analysis::{HeldAnalysisChanges, PendingAnalysisChange};
use narsil::suggestions_host::HistoryFiles;
use narsil::{AnalysisChange, IndexConfig, Value};

use super::blocking::off_executor;
use super::copies::LocalCopies;
use super::role::DataRole;
use super::stored_index::stored_index;
use crate::error::{ClusterResult, codes};

impl DataRole {
    pub(super) async fn on_copies<T, F>(&self, work: F) -> ClusterResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&LocalCopies) -> ClusterResult<T> + Send + 'static,
    {
        let copies = self.settled_copies()?;
        off_executor(move || work(&copies)).await?
    }

    pub(crate) fn history_files(&self) -> ClusterResult<HistoryFiles> {
        Ok(HistoryFiles::of_engine(&self.settled_copies()?.engine))
    }

    pub(crate) fn refuse_orphaned_name(&self, index_name: &str) -> ClusterResult<()> {
        match self.settled_copies() {
            Ok(copies) => copies.refuse_orphaned(index_name),
            Err(_) => Ok(()),
        }
    }

    pub(crate) async fn create_local_index(
        &self,
        index_name: &str,
        config: IndexConfig,
        index_uuid: &str,
        partition_count: u32,
    ) -> ClusterResult<Value> {
        let (name, uuid) = (index_name.to_string(), index_uuid.to_string());
        self.on_copies(move |copies| {
            copies.create_new_copy(&name, config, &uuid, partition_count)?;
            Ok(copies.schema_of(&name)?)
        })
        .await
    }

    pub(crate) async fn check_analysis_change(
        &self,
        serving_name: &str,
        public_name: &str,
        schema: &Value,
        change: &AnalysisChange,
    ) -> ClusterResult<Option<PendingAnalysisChange>> {
        let Some(stored) = stored_index(&self.coordinator, serving_name, schema).await? else {
            return Ok(None);
        };
        let (name, change) = (public_name.to_string(), change.clone());
        self.on_copies(move |copies| {
            Ok(
                HeldAnalysisChanges::new(&copies.engine).check_analysis_change(
                    &name,
                    &stored.config,
                    &change,
                )?,
            )
        })
        .await
        .map(Some)
    }

    pub(crate) async fn lists_local_index(&self, index_name: &str) -> ClusterResult<bool> {
        let name = index_name.to_string();
        self.on_copies(move |copies| Ok(copies.holds_index(&name)))
            .await
    }

    pub(crate) async fn drop_local_index(
        &self,
        index_name: &str,
        when_listed: bool,
    ) -> ClusterResult<()> {
        let name = index_name.to_string();
        let dropped = self
            .on_copies(move |copies| {
                if when_listed && !copies.holds_index(&name) {
                    return Ok(());
                }
                copies.drop_local_index(&name)
            })
            .await;
        match dropped {
            Err(error) if when_listed && error.code() == codes::INDEX_NOT_FOUND => Ok(()),
            other => other,
        }
    }

    pub(crate) async fn holds_local_copy(
        &self,
        index_name: &str,
        dropped_uuid: Option<&str>,
    ) -> ClusterResult<bool> {
        let (name, dropped) = (index_name.to_string(), dropped_uuid.map(str::to_string));
        self.on_copies(move |copies| {
            if !copies.holds_index(&name) {
                return Ok(false);
            }
            let local = copies.local_uuid(&name)?;
            Ok(match (dropped.as_deref(), local.as_deref()) {
                (None, _) | (_, None) => true,
                (Some(dropped), Some(local)) => dropped == local,
            })
        })
        .await
    }

    pub(crate) async fn forget_index(&self, index_name: &str) -> ClusterResult<()> {
        if let Ok(writes) = self.primary_writes() {
            writes.forget_index(index_name);
        }
        let name = index_name.to_string();
        self.on_copies(move |copies| {
            if !copies.holds_index(&name) {
                copies.forget_orphan(&name);
            }
            Ok(())
        })
        .await
    }
}
