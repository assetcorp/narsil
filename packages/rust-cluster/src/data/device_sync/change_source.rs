use std::sync::Arc;

use narsil::{
    ChangeSource, ChangesIndexState, DocumentTest, ErrorCode, Filter, IndexConfig, Narsil,
    NarsilError, Value,
};

use super::admission::CHANGE_CAPTURE_READINESS;
use super::bridge::wait_on;
use super::feed_source::FeedParts;
use super::shared_source::SharedFeedSource;
use crate::data::stored_index::stored_index;
use crate::error::{ClusterError, ClusterResult, codes};

fn changes_not_enabled(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::CHANGES_NOT_ENABLED,
        format!("Index \"{index_name}\" has change capture off"),
    )
    .with_details([("indexName", Value::from(index_name))])
}

async fn stored_config(parts: Arc<FeedParts>, serving_name: String) -> ClusterResult<IndexConfig> {
    let not_enabled = || {
        ClusterError::new(
            codes::CHANGES_NOT_ENABLED,
            format!("Index \"{serving_name}\" has change capture off"),
        )
    };
    let Some(schema) = parts.coordinator.schema(&serving_name).await? else {
        return Err(not_enabled());
    };
    let Some(stored) = stored_index(&parts.coordinator, &serving_name, &schema).await? else {
        return Err(not_enabled());
    };
    Ok(stored.config)
}

impl SharedFeedSource {
    fn with_schema<T>(
        &self,
        index_name: &str,
        read: impl Fn(&Narsil, &str) -> narsil::Result<T>,
    ) -> narsil::Result<(Option<Arc<Narsil>>, T)> {
        let parts = self.0.parts()?;
        let Some(held) = self.0.held_now(index_name)? else {
            return Err(changes_not_enabled(index_name));
        };
        let serving_name = held.serving.serving_name;
        if parts.copies.index_names().contains(&serving_name) {
            return Ok((None, read(&parts.copies.engine, &serving_name)?));
        }
        let mut config = wait_on(
            &parts.runtime,
            stored_config(Arc::clone(&parts), serving_name.clone()),
        )?;
        config.embedding = None;
        let engine = Arc::new(Narsil::new());
        engine.create_index(&serving_name, config)?;
        let answer = read(&engine, &serving_name)?;
        Ok((Some(engine), answer))
    }
}

impl ChangeSource for SharedFeedSource {
    fn changes_state(&self, index: &str) -> narsil::Result<Option<ChangesIndexState>> {
        let held = self.0.held_now(index)?;
        Ok(held.and_then(|held| {
            let changes = held.states.changes?;
            Some(ChangesIndexState {
                epoch: changes.epoch,
                partition_count: held.serving.partition_count,
                previous_document: changes.previous_document,
            })
        }))
    }

    fn document_test(&self, index: &str, filter: &Filter) -> narsil::Result<DocumentTest> {
        let (engine, test) = self.with_schema(index, |engine, name| {
            engine.feed_source().document_test(name, filter)
        })?;
        Ok(Box::new(move |document| {
            let _schema_holder = &engine;
            test(document)
        }))
    }

    fn vector_fields(&self, index: &str) -> narsil::Result<Vec<String>> {
        self.with_schema(index, |engine, name| engine.vector_fields(name))
            .map(|(_, fields)| fields)
    }

    fn admit_changes(&self, index: &str) -> narsil::Result<()> {
        self.admit(index, &CHANGE_CAPTURE_READINESS)
    }
}
