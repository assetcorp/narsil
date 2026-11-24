use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::watch;

use super::super::PrimaryWrites;
use super::super::partition::Partition;
use crate::allocator::{Assignment, Table};
use crate::constants::{
    LEAD_HANDOFF_TABLE_READ_RETRY_DELAY_CAP_MS, LEAD_HANDOFF_TABLE_READ_RETRY_INITIAL_DELAY_MS,
};

struct HeldLead {
    partition: Arc<Partition>,
    index_name: String,
    partition_id: u32,
    primary_term: u64,
    number: u64,
}

fn leads_under(assignment: Option<&Assignment>, node_id: &str, primary_term: u64) -> bool {
    assignment.is_some_and(|assignment| {
        assignment.is_primary(node_id) && assignment.primary_term as u64 == primary_term
    })
}

async fn changed_or_closed(receiver: &mut watch::Receiver<impl Sized>) -> bool {
    receiver.changed().await.is_ok()
}

impl PrimaryWrites {
    pub(super) async fn hold_until_released(
        self: Arc<Self>,
        partition: Arc<Partition>,
        index_name: String,
        partition_id: u32,
        primary_term: u64,
        number: u64,
    ) {
        let held = HeldLead {
            partition,
            index_name,
            partition_id,
            primary_term,
            number,
        };
        self.wait_for_release(&held).await;
        held.partition.end_lead_hold(held.number);
    }

    fn leads_in_view(&self, held: &HeldLead) -> bool {
        let assignment = self
            .view
            .held_assignment(&held.index_name, held.partition_id);
        leads_under(assignment.as_ref(), &self.node_id, held.primary_term)
    }

    fn leads_in_table(&self, held: &HeldLead, table: Option<&Table>) -> bool {
        let assignment =
            table.and_then(|table| table.assignments.get(f64::from(held.partition_id)));
        leads_under(assignment, &self.node_id, held.primary_term)
    }

    async fn wait_for_release(&self, held: &HeldLead) {
        let mut table_changes = self.view.changes();
        let mut hold_changes = held.partition.lead_hold_changes.subscribe();
        let mut stopping = self.stopping.subscribe();
        let mut shutting_down = self.shutting_down.subscribe();
        let mut retry_delay = Duration::from_millis(LEAD_HANDOFF_TABLE_READ_RETRY_INITIAL_DELAY_MS);
        loop {
            let Some(deadline) = held.partition.lead_hold_deadline(held.number) else {
                return;
            };
            if self.is_stopping() || *self.shutting_down.borrow() || !self.leads_in_view(held) {
                return;
            }
            if Instant::now() < deadline {
                tokio::select! {
                    open = changed_or_closed(&mut table_changes) => if !open { return },
                    open = changed_or_closed(&mut hold_changes) => if !open { return },
                    _ = stopping.changed() => return,
                    _ = shutting_down.changed() => return,
                    () = tokio::time::sleep_until(deadline.into()) => {}
                }
                continue;
            }
            let read = tokio::select! {
                open = changed_or_closed(&mut table_changes) => {
                    if !open { return }
                    continue;
                },
                open = changed_or_closed(&mut hold_changes) => {
                    if !open { return }
                    continue;
                },
                _ = stopping.changed() => return,
                _ = shutting_down.changed() => return,
                read = self.view.read_live(&held.index_name) => read,
            };
            match read {
                Ok(table) => {
                    if !self.leads_in_table(held, table.as_ref())
                        || held.partition.end_expired_lead_hold(held.number)
                    {
                        return;
                    }
                }
                Err(_) => {
                    tokio::select! {
                        open = changed_or_closed(&mut hold_changes) => if !open { return },
                        _ = stopping.changed() => return,
                        _ = shutting_down.changed() => return,
                        () = tokio::time::sleep(retry_delay) => {}
                    }
                    retry_delay = (retry_delay * 2).min(Duration::from_millis(
                        LEAD_HANDOFF_TABLE_READ_RETRY_DELAY_CAP_MS,
                    ));
                }
            }
        }
    }
}
