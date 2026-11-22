use std::time::Duration;

use tokio::time::{Instant, sleep, timeout_at};

use super::WriteRouter;
use crate::allocator::Table;
use crate::constants::{
    FORWARD_RETRY_DELAY_CAP_MS, FORWARD_RETRY_LAST_ATTEMPT_ROOM_MS, PRIMARY_CHANGE_POLL_INTERVAL_MS,
};
use crate::data::routed_partition;

#[derive(Debug, Clone)]
pub(super) struct RefusingPrimary {
    partition_count: usize,
    partition_id: u32,
    primary: Option<String>,
    primary_term: f64,
}

pub(super) fn primary_for(table: Option<&Table>, document_id: &str) -> Option<RefusingPrimary> {
    let table = table.filter(|table| !table.assignments.is_empty())?;
    let partition_count = table.assignments.len();
    let partition_id = routed_partition(document_id, partition_count);
    let assignment = table.assignments.get(f64::from(partition_id));
    Some(RefusingPrimary {
        partition_count,
        partition_id,
        primary: assignment.and_then(|assignment| assignment.primary.clone()),
        primary_term: assignment.map_or(0.0, |assignment| assignment.primary_term),
    })
}

fn moved_on(table: &Table, refusing: &RefusingPrimary) -> bool {
    if table.assignments.len() != refusing.partition_count {
        return true;
    }
    let Some(assignment) = table.assignments.get(f64::from(refusing.partition_id)) else {
        return false;
    };
    let Some(primary) = &assignment.primary else {
        return false;
    };
    refusing.primary.as_ref() != Some(primary) || assignment.primary_term > refusing.primary_term
}

pub(super) fn next_retry_delay(delay: Duration) -> Duration {
    (delay * 2).min(Duration::from_millis(FORWARD_RETRY_DELAY_CAP_MS))
}

impl WriteRouter {
    pub(super) async fn pause_and_reread(
        &self,
        serving_name: &str,
        delay: Duration,
        deadline: Instant,
    ) -> bool {
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        sleep(delay.min(deadline - now)).await;
        if self.is_stopping() {
            return false;
        }
        match timeout_at(deadline, self.view.refresh(serving_name)).await {
            Err(_) | Ok(Ok(None)) => return false,
            Ok(_) => {}
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining >= Duration::from_millis(FORWARD_RETRY_LAST_ATTEMPT_ROOM_MS) {
            return true;
        }
        sleep(remaining).await;
        false
    }

    pub(super) async fn await_new_primary(
        &self,
        serving_name: &str,
        refusing: &[RefusingPrimary],
        deadline: Instant,
    ) -> bool {
        while Instant::now() < deadline {
            if self.is_stopping() {
                return false;
            }
            match timeout_at(deadline, self.view.refresh(serving_name)).await {
                Err(_) | Ok(Ok(None)) => return false,
                Ok(Ok(Some(table))) if refusing.iter().any(|primary| moved_on(&table, primary)) => {
                    return true;
                }
                _ => {}
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            sleep(remaining.min(Duration::from_millis(PRIMARY_CHANGE_POLL_INTERVAL_MS))).await;
        }
        false
    }
}
