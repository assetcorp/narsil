use narsil::replication::ReplicatedEntry;

use super::feed::run_bytes;
use crate::controller::lock;
use crate::data::writes::PrimaryWrites;
use crate::data::writes::partition::Partition;
use crate::data::writes::replicate::acknowledges;
use crate::data::writes::scope::Scope;
use crate::error::codes;
use crate::message::message_types;
use crate::payload::sync::{encode_partition_stores_request, stores_lists};

#[derive(PartialEq, Eq)]
enum HeldEntryAnswer {
    Acknowledged,
    RefusedAsInvalid,
    Unconfirmed,
}

impl PrimaryWrites {
    pub(super) fn epoch_moved(
        &self,
        partition: &Partition,
        replica_node_id: &str,
        epoch: u64,
    ) -> bool {
        lock(&partition.catch_up)
            .cursors
            .get(replica_node_id)
            .is_none_or(|cursor| cursor.sync_epoch != epoch)
    }

    pub(super) async fn prove_position(
        &self,
        partition: &Partition,
        scope: &Scope,
        replica_node_id: &str,
        applied_seq_no: u64,
    ) -> bool {
        if applied_seq_no == 0 {
            return true;
        }
        let entry = lock(&partition.log).entry_at(applied_seq_no).cloned();
        let Some(proving_epoch) = lock(&partition.catch_up)
            .cursors
            .get(replica_node_id)
            .map(|cursor| cursor.sync_epoch)
        else {
            return false;
        };
        let Some(entry) = entry else {
            let listed = self.replica_lists_partition(scope, replica_node_id).await;
            return listed && !self.epoch_moved(partition, replica_node_id, proving_epoch);
        };
        let answer = self.send_held_entry(scope, entry, replica_node_id).await;
        let same_epoch = !self.epoch_moved(partition, replica_node_id, proving_epoch);
        if answer == HeldEntryAnswer::RefusedAsInvalid && same_epoch {
            lock(&partition.catch_up).forget_replica(replica_node_id);
        }
        answer == HeldEntryAnswer::Acknowledged && same_epoch
    }

    async fn send_held_entry(
        &self,
        scope: &Scope,
        entry: ReplicatedEntry,
        replica_node_id: &str,
    ) -> HeldEntryAnswer {
        let seq_no = entry.seq_no;
        let entries = [entry];
        let Some(_reserved) = self.reserve(run_bytes(&scope.index_name, &entries)) else {
            return HeldEntryAnswer::Unconfirmed;
        };
        let Ok(Some(message)) = self.entry_message(scope, &entries).await else {
            return HeldEntryAnswer::Unconfirmed;
        };
        let Ok(answer) = self.send_to_node(replica_node_id, &message).await else {
            return HeldEntryAnswer::Unconfirmed;
        };
        if acknowledges(&answer, &scope.index_name, scope.partition_id, seq_no) {
            return HeldEntryAnswer::Acknowledged;
        }
        match answer.failure() {
            Some(refusal) if refusal.code() == codes::REPLICATION_ENTRY_INVALID => {
                HeldEntryAnswer::RefusedAsInvalid
            }
            _ => HeldEntryAnswer::Unconfirmed,
        }
    }

    async fn replica_lists_partition(&self, scope: &Scope, replica_node_id: &str) -> bool {
        let payload = encode_partition_stores_request(&scope.index_name);
        let Ok(message) = self.message(message_types::CLUSTER_PARTITION_STORES, payload) else {
            return false;
        };
        for target in self.view.targets(replica_node_id) {
            let Ok(answer) = self.transport.send(&target, message.clone()).await else {
                continue;
            };
            return !answer.is_failure()
                && stores_lists(
                    &answer.payload,
                    &scope.index_name,
                    scope.index_uuid.as_deref(),
                    scope.partition_id,
                );
        }
        false
    }
}
