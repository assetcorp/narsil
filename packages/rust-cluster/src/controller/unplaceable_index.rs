use std::collections::HashSet;

use super::Inner;
use super::allocation::lost_every_attempt;
use super::departures::DepartureRun;
use super::metadata::index_metadata;
use super::table::{
    TableWrite, belongs_to_another_index, put_allocation_over, stamped_with, stored_table,
};
use crate::allocator::assignments_without_departed_nodes;
use crate::constants::ALLOCATION_CAS_ATTEMPTS;
use crate::error::ClusterResult;

impl Inner {
    pub(super) async fn fail_over_without_placement(
        &self,
        index_name: &str,
        registered: &HashSet<String>,
        departures: &mut DepartureRun,
    ) -> ClusterResult<()> {
        for _ in 0..ALLOCATION_CAS_ATTEMPTS {
            let Some(table) = stored_table(self.coordinator(), index_name).await? else {
                return Ok(());
            };
            if table.generation.is_some() || !self.is_active() {
                return Ok(());
            }
            let Some(metadata) = index_metadata(self.coordinator(), index_name).await? else {
                return Ok(());
            };
            if belongs_to_another_index(&table, Some(&metadata.index_uuid)) {
                return Ok(());
            }
            let retained = self.retained_nodes_for(departures, &table);
            let Some(assignments) =
                assignments_without_departed_nodes(&table.assignments, registered, &retained)
            else {
                return Ok(());
            };
            if !self.is_active() {
                return Ok(());
            }
            let mut next = table.clone();
            next.version += 1.0;
            next.assignments = assignments;
            let write = TableWrite {
                index_name,
                previous: Some(&table),
                writer_node_id: self.node_id(),
                replica: None,
            };
            let next = stamped_with(next, Some(&metadata.index_uuid));
            if put_allocation_over(self.coordinator(), write, next).await? {
                return Ok(());
            }
        }
        Err(lost_every_attempt(index_name))
    }
}
