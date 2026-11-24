use std::collections::HashMap;

use super::PrimaryWrites;
use crate::controller::lock;

pub(crate) struct LedPartitionFigures {
    pub(crate) commit_point: u64,
    pub(crate) log_end: u64,
    pub(crate) acknowledged: HashMap<String, u64>,
}

impl PrimaryWrites {
    pub(crate) async fn led_partition_figures(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> Option<LedPartitionFigures> {
        let name = index_name.to_string();
        let log_end = self
            .on_copies(move |copies| copies.position(&name, partition_id))
            .await
            .ok()?
            .seq_no;
        let Some(partition) = self.partitions.existing(index_name, partition_id) else {
            return Some(LedPartitionFigures {
                commit_point: log_end,
                log_end,
                acknowledged: HashMap::new(),
            });
        };
        let commit_point = {
            let log = lock(&partition.log);
            match log.newest_seq_no() {
                Some(_) => log.commit_point(),
                None => log_end,
            }
        };
        let acknowledged = lock(&partition.catch_up)
            .cursors
            .iter()
            .map(|(replica, cursor)| (replica.clone(), cursor.applied_seq_no))
            .collect();
        Some(LedPartitionFigures {
            commit_point,
            log_end,
            acknowledged,
        })
    }
}
