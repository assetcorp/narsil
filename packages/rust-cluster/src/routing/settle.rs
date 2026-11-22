use std::collections::{BTreeMap, HashMap, HashSet};

use narsil::{Map, Value};

use super::WriteRouter;
use super::sent_fields::stored_copy_matches_sent;
use super::write::{PendingWrite, Refused};
use crate::controller::stored_index_metadata;
use crate::data::routed_partition;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::payload::client::{decode_answer, encode_fetch_request, fetched_documents};

#[derive(Default)]
pub(super) struct Settlement {
    pub(super) settled: HashSet<usize>,
    pub(super) unverified: HashSet<usize>,
}

fn unreadable(serving_name: &str) -> ClusterError {
    ClusterError::new(
        codes::QUERY_ROUTING_FAILED,
        format!("No allocation table names the primaries of index '{serving_name}'"),
    )
}

fn embedding_fields(settings: Option<&Value>) -> HashSet<String> {
    let fields = match settings {
        Some(Value::Object(settings)) => match settings.get("embedding") {
            Some(Value::Object(embedding)) => embedding.get("fields"),
            _ => None,
        },
        _ => None,
    };
    match fields {
        Some(Value::Object(fields)) => fields.keys().cloned().collect(),
        _ => HashSet::new(),
    }
}

impl WriteRouter {
    async fn derived_fields(&self, serving_name: &str) -> ClusterResult<HashSet<String>> {
        let stored = stored_index_metadata(&self.coordinator, serving_name).await?;
        Ok(stored.map_or_else(HashSet::new, |(_, settings)| {
            embedding_fields(settings.as_ref())
        }))
    }

    async fn fetch_from(
        &self,
        serving_name: &str,
        primary: &str,
        documents: &[(String, u32)],
    ) -> ClusterResult<Vec<(String, Map)>> {
        let payload = encode_fetch_request(serving_name, documents);
        let answer = self
            .send_to_primary(primary, message_types::QUERY_FETCH, payload)
            .await?;
        let decoded = decode_answer(&answer, serving_name).map_err(|failure| failure.error)?;
        fetched_documents(&decoded)
    }

    async fn primary_copies(
        &self,
        serving_name: &str,
        document_ids: &[&str],
    ) -> ClusterResult<HashMap<String, Map>> {
        let Some(table) = self.view.refresh(serving_name).await? else {
            return Err(unreadable(serving_name));
        };
        let partition_count = table.assignments.len();
        if partition_count == 0 {
            return Err(unreadable(serving_name));
        }
        let mut by_primary: BTreeMap<String, Vec<(String, u32)>> = BTreeMap::new();
        for document_id in document_ids {
            let partition_id = routed_partition(document_id, partition_count);
            let Some(primary) = table
                .assignments
                .get(f64::from(partition_id))
                .and_then(|assignment| assignment.primary.clone())
            else {
                continue;
            };
            by_primary
                .entry(primary)
                .or_default()
                .push((document_id.to_string(), partition_id));
        }
        let mut copies = HashMap::new();
        for (primary, documents) in by_primary {
            match &self.local {
                Some(local) if primary == self.node_id => {
                    for (document_id, _) in documents {
                        if let Some(copy) =
                            local.stored_document(serving_name, &document_id).await?
                        {
                            copies.insert(document_id, copy);
                        }
                    }
                }
                _ => {
                    for (document_id, copy) in
                        self.fetch_from(serving_name, &primary, &documents).await?
                    {
                        copies.insert(document_id, copy);
                    }
                }
            }
        }
        Ok(copies)
    }

    pub(super) async fn settle_equal_inserts(
        &self,
        serving_name: &str,
        failures: &[(&PendingWrite, &Refused)],
        acknowledged: &HashSet<String>,
    ) -> Settlement {
        let existing: Vec<&PendingWrite> = failures
            .iter()
            .filter(|(write, refused)| {
                refused.error.code() == codes::DOC_ALREADY_EXISTS
                    && !acknowledged.contains(write.document_id())
            })
            .map(|(write, _)| *write)
            .collect();
        let mut settlement = Settlement::default();
        if existing.is_empty() {
            return settlement;
        }
        let mut document_ids: Vec<&str> =
            existing.iter().map(|write| write.document_id()).collect();
        document_ids.sort_unstable();
        document_ids.dedup();
        let read = match self.primary_copies(serving_name, &document_ids).await {
            Ok(stored) => self
                .derived_fields(serving_name)
                .await
                .map(|derived| (stored, derived)),
            Err(error) => Err(error),
        };
        let Ok((stored, derived)) = read else {
            settlement.unverified = existing.iter().map(|write| write.position).collect();
            return settlement;
        };
        let mut settled_ids = HashSet::new();
        for write in existing {
            let document_id = write.document_id();
            if settled_ids.contains(document_id) {
                continue;
            }
            let Some(copy) = stored.get(document_id) else {
                settlement.unverified.insert(write.position);
                continue;
            };
            let Some(sent) = &write.write.sent else {
                continue;
            };
            let stores_its_id = copy.get("id").and_then(Value::as_str) == Some(document_id)
                && !sent.contains_key("id");
            let matched = if stores_its_id {
                let mut with_id = derived.clone();
                with_id.insert("id".to_string());
                stored_copy_matches_sent(sent, copy, &with_id)
            } else {
                stored_copy_matches_sent(sent, copy, &derived)
            };
            if matched {
                settlement.settled.insert(write.position);
                settled_ids.insert(document_id.to_string());
            }
        }
        settlement
    }
}
