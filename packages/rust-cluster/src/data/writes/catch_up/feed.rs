use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use narsil::replication::ReplicatedEntry;

use super::state::{Feed, Registered};
use crate::allocator::Assignment;
use crate::constants::{CATCH_UP_FEED_WINDOW_MS, CATCH_UP_TICK_MS, MAX_CATCH_UP_IN_FLIGHT_BYTES};
use crate::controller::lock;
use crate::data::writes::PrimaryWrites;
use crate::data::writes::log::entry_bytes;
use crate::data::writes::partition::{Partition, PartitionKey};
use crate::data::writes::scope::Scope;
use crate::error::ClusterResult;

pub(in crate::data::writes) struct Reserved<'a> {
    bytes: u64,
    total: &'a AtomicU64,
}

impl Drop for Reserved<'_> {
    fn drop(&mut self) {
        self.total.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

pub(in crate::data::writes) fn run_bytes(index_name: &str, entries: &[ReplicatedEntry]) -> u64 {
    entries
        .iter()
        .map(|entry| entry_bytes(index_name, entry))
        .sum()
}

pub(in crate::data::writes) fn scope_of(
    key: &PartitionKey,
    assignment: &Assignment,
    index_uuid: Option<String>,
) -> Scope {
    Scope {
        index_name: key.0.clone(),
        partition_id: key.1,
        primary_term: assignment.primary_term as u64,
        assignment: assignment.clone(),
        index_uuid,
    }
}

impl PrimaryWrites {
    pub(in crate::data::writes) fn reserve(&self, bytes: u64) -> Option<Reserved<'_>> {
        let total = &self.catch_up_bytes;
        let mut held = total.load(Ordering::Acquire);
        loop {
            let after = held
                .checked_add(bytes)
                .filter(|after| *after <= MAX_CATCH_UP_IN_FLIGHT_BYTES)?;
            match total.compare_exchange_weak(held, after, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return Some(Reserved { bytes, total }),
                Err(current) => held = current,
            }
        }
    }

    pub(in crate::data::writes) async fn registered_nodes(&self) -> Registered {
        let nodes = self.coordinator.list_nodes().await.ok()?;
        Some(
            nodes
                .into_iter()
                .map(|node| (node.node_id, node.started_at))
                .collect::<HashMap<String, String>>(),
        )
    }

    pub(in crate::data::writes) fn start_catch_up_pump(self: &Arc<Self>) {
        let writes = Arc::clone(self);
        let mut stopping = self.stopping.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_millis(CATCH_UP_TICK_MS)) => {}
                    _ = stopping.wait_for(|stopped| *stopped) => return,
                }
                writes.catch_up_tick().await;
            }
        });
    }

    pub(in crate::data::writes) fn cancel_catch_up_feeds(&self) {
        for (_, partition) in self.partitions.held() {
            lock(&partition.catch_up).cancel_feeds();
        }
    }

    async fn catch_up_tick(self: &Arc<Self>) {
        let led: Vec<(PartitionKey, Arc<Partition>)> = self
            .partitions
            .held()
            .into_iter()
            .filter(|(_, partition)| !lock(&partition.catch_up).is_idle())
            .collect();
        if led.is_empty() {
            return;
        }
        let registered = self.registered_nodes().await;
        for (key, partition) in led {
            if self.is_stopping() {
                return;
            }
            let _ = self.pump_partition(&key, &partition, &registered).await;
        }
    }

    async fn pump_partition(
        self: &Arc<Self>,
        key: &PartitionKey,
        partition: &Arc<Partition>,
        registered: &Registered,
    ) -> ClusterResult<()> {
        let generation_at_live_read = lock(&partition.catch_up).last_generation();
        let table = self.view.read_live(&key.0).await?;
        let assignment = table
            .as_ref()
            .and_then(|table| table.assignments.get(f64::from(key.1)))
            .filter(|assignment| assignment.is_primary(&self.node_id))
            .cloned();
        let Some(assignment) = assignment else {
            lock(&partition.catch_up).forget_led_state();
            return Ok(());
        };
        let scope = scope_of(key, &assignment, table.and_then(|table| table.index_uuid));
        self.withdraw_applied_admissions(partition, &scope);
        self.settle_admissions_in_queue(partition, &assignment);
        let started = self.claim_feeds(partition, &assignment, registered, generation_at_live_read);
        for (replica_node_id, feed) in started {
            let (writes, partition, scope) =
                (Arc::clone(self), Arc::clone(partition), scope.clone());
            tokio::spawn(async move {
                writes
                    .feed_replica(&partition, &scope, &replica_node_id, &feed)
                    .await;
                let mut catch_up = lock(&partition.catch_up);
                if let Some(cursor) = catch_up.cursors.get_mut(&replica_node_id)
                    && cursor
                        .feed
                        .as_ref()
                        .is_some_and(|held| Arc::ptr_eq(held, &feed))
                {
                    cursor.feed = None;
                    cursor.busy = false;
                }
            });
        }
        Ok(())
    }

    fn settle_admissions_in_queue(
        self: &Arc<Self>,
        partition: &Arc<Partition>,
        assignment: &Assignment,
    ) {
        let settled = {
            let mut catch_up = lock(&partition.catch_up);
            if catch_up.settling {
                return;
            }
            let settled = catch_up.settled_admissions(assignment);
            if settled.is_empty() {
                return;
            }
            catch_up.settling = true;
            settled
        };
        let partition = Arc::clone(partition);
        tokio::spawn(async move {
            let _turn = partition.turn().await;
            let mut catch_up = lock(&partition.catch_up);
            for (replica_node_id, generation) in settled {
                catch_up.forget_settled(&replica_node_id, generation);
            }
            catch_up.settling = false;
        });
    }

    fn claim_feeds(
        &self,
        partition: &Partition,
        assignment: &Assignment,
        registered: &Registered,
        generation_at_live_read: u64,
    ) -> Vec<(String, Arc<Feed>)> {
        let mut catch_up = lock(&partition.catch_up);
        let admitted = catch_up.admitted_beyond_table(assignment, Some(generation_at_live_read));
        let pending = catch_up.pending_admissions();
        let replicas: Vec<String> = catch_up.cursors.keys().cloned().collect();
        let mut started = Vec::new();
        for replica_node_id in replicas {
            if self.is_stopping() {
                break;
            }
            if !assignment.holds_replica(&replica_node_id) {
                catch_up.forget_replica(&replica_node_id);
                continue;
            }
            if admitted.contains(&replica_node_id) {
                continue;
            }
            if assignment.holds_in_sync(&replica_node_id) {
                if !pending.contains(&replica_node_id) {
                    catch_up.forget_replica(&replica_node_id);
                }
                continue;
            }
            let Some(cursor) = catch_up.cursors.get_mut(&replica_node_id) else {
                continue;
            };
            if cursor.busy {
                if let Some(feed) = &cursor.feed
                    && feed.is_stale(assignment, registered, &replica_node_id)
                {
                    feed.cancel();
                }
                continue;
            }
            let started_at = registered
                .as_ref()
                .and_then(|registered| registered.get(&replica_node_id).cloned());
            let feed = Feed::new(assignment, started_at);
            cursor.busy = true;
            cursor.feed = Some(Arc::clone(&feed));
            started.push((replica_node_id, feed));
        }
        started
    }

    async fn feed_replica(
        self: &Arc<Self>,
        partition: &Arc<Partition>,
        scope: &Scope,
        replica_node_id: &str,
        feed: &Arc<Feed>,
    ) {
        let deadline = Instant::now() + Duration::from_millis(CATCH_UP_FEED_WINDOW_MS);
        let mut answered = false;
        while !self.is_stopping() && !feed.is_cancelled() {
            let Some((applied, confirmed, _)) = Self::cursor_state(partition, replica_node_id)
            else {
                return;
            };
            let Ok((log_end, oldest)) = self.retained_span(partition, scope).await else {
                return;
            };
            let fallen_behind = match oldest {
                Some(oldest) => applied + 1 < oldest,
                None => applied < log_end,
            };
            if fallen_behind {
                lock(&partition.catch_up).forget_replica(replica_node_id);
                return;
            }
            if applied >= log_end {
                if confirmed {
                    let proposal = self.spawn_admission(partition, scope, replica_node_id, None);
                    feed.until_cancelled(proposal, Ok(())).await.ok();
                }
                return;
            }
            if Instant::now() >= deadline {
                return;
            }
            let (batch, missing) = Self::next_batch(partition, applied + 1);
            if batch.is_empty() {
                return;
            }
            if answered && batch.len() == missing {
                self.close_gap_in_queue(partition, scope, replica_node_id, feed)
                    .await;
                return;
            }
            if !self
                .send_batch(partition, scope, &batch, replica_node_id, feed)
                .await
            {
                return;
            }
            answered = true;
        }
    }
}
