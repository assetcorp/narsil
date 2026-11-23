use narsil::{IndexInfo, Map, MemoryStats, Value, encode_msgpack};

use super::DataRole;
use crate::data::reconcile::apply_stored_settings;
use crate::data::writes::LedPartitionFigures;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};
use crate::node::decode_request_payload;

fn index_settings_request(message: &TransportMessage) -> ClusterResult<(String, String)> {
    let decoded = decode_request_payload(&message.payload, &message.message_type)?;
    let text = |key: &str| match &decoded {
        Value::Object(fields) => match fields.get(key) {
            Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
            _ => None,
        },
        _ => None,
    };
    match (text("indexName"), text("indexUuid")) {
        (Some(index_name), Some(index_uuid)) => Ok((index_name, index_uuid)),
        _ => Err(ClusterError::new(
            codes::CONFIG_INVALID,
            "Invalid IndexSettingsPayload: it needs an indexName and an indexUuid that are non-empty strings",
        )),
    }
}

impl DataRole {
    pub(crate) async fn local_memory(&self) -> ClusterResult<(MemoryStats, Vec<IndexInfo>)> {
        self.on_copies(|copies| {
            Ok((
                copies.engine.get_memory_stats(),
                copies.engine.list_indexes(),
            ))
        })
        .await
    }

    pub(crate) async fn checkpoint_local(&self, index_name: &str) -> ClusterResult<()> {
        let name = index_name.to_string();
        self.on_copies(move |copies| Ok(copies.engine.checkpoint(&name)?))
            .await
    }

    pub(crate) async fn clear_local(&self, index_name: &str) -> ClusterResult<()> {
        let name = index_name.to_string();
        self.on_copies(move |copies| Ok(copies.engine.clear(&name)?))
            .await
    }

    pub(crate) async fn open_local(&self, index_name: &str) -> ClusterResult<()> {
        let name = index_name.to_string();
        self.on_copies(move |copies| Ok(copies.engine.open_index(&name)?))
            .await
    }

    pub(crate) async fn close_local(&self, index_name: &str) -> ClusterResult<()> {
        let name = index_name.to_string();
        self.on_copies(move |copies| Ok(copies.engine.close_index(&name)?))
            .await?;
        if let Ok(writes) = self.primary_writes() {
            writes.forget_index(index_name);
        }
        Ok(())
    }

    pub(crate) async fn led_partition_figures(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> Option<LedPartitionFigures> {
        self.primary_writes()
            .ok()?
            .led_partition_figures(index_name, partition_id)
            .await
    }

    pub(crate) async fn apply_index_settings(
        &self,
        index_name: &str,
        index_uuid: &str,
    ) -> ClusterResult<bool> {
        let copies = self.settled_copies()?;
        apply_stored_settings(&self.coordinator, &copies, index_name, index_uuid).await
    }

    pub(crate) async fn rebuild_local_analysis(
        &self,
        index_name: &str,
        index_uuid: &str,
    ) -> ClusterResult<()> {
        self.analysis_changes()?
            .rebuild_held_copies(index_name, index_uuid)
            .await
            .map(|_| ())
    }

    pub(super) async fn answer_index_settings(
        &self,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let (index_name, index_uuid) = index_settings_request(message)?;
        let applied = self.apply_index_settings(&index_name, &index_uuid).await?;
        let mut payload = Map::with_capacity(2);
        payload.insert("indexName", Value::String(index_name));
        payload.insert("applied", Value::Bool(applied));
        let encoded = encode_msgpack(&Value::Object(payload)).map_err(ClusterError::from)?;
        Ok(TransportMessage::new(
            message_types::CLUSTER_INDEX_SETTINGS,
            &self.node_id,
            &message.request_id,
            encoded,
        ))
    }
}
