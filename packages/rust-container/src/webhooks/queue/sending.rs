use std::sync::Arc;

use super::super::constants::{
    MAX_RETRY_JITTER_FRACTION, MAX_SENDS_IN_FLIGHT, PERSISTENCE_RETRY_DELAY_MS, RETRY_DELAYS_MS,
};
use super::super::delivery::random_fraction;
use super::super::send::{SendOutcome, send};
use super::{Command, Queue, Waiting};
use crate::events::body::now_ms;

impl Queue {
    pub(super) fn save(&mut self, id: &str) {
        let Some(entry) = self.entries.get_mut(id) else {
            return;
        };
        entry.waiting = Waiting::Saving;
        let commands = self.commands.clone();
        let (owner, admission) = (id.to_string(), entry.admission);
        self.config.store.save(&entry.delivery, move |written| {
            let _ = commands.send(Command::Saved {
                id: owner,
                admission,
                written,
            });
        });
    }

    pub(super) fn saved(&mut self, id: &str, admission: u64, written: bool) {
        if !written {
            self.config.reports.persistence_error("save", id);
        }
        if self.closed {
            return;
        }
        let Some(entry) = self.current(id, admission) else {
            return;
        };
        if entry.waiting != Waiting::Saving {
            return;
        }
        if written {
            self.schedule(id);
            return;
        }
        let at = now_ms() + PERSISTENCE_RETRY_DELAY_MS;
        entry.waiting = Waiting::SaveRetry(at);
        self.timers.insert((at, admission));
    }

    pub(super) fn schedule(&mut self, id: &str) {
        let now = now_ms();
        let Some(entry) = self.entries.get_mut(id) else {
            return;
        };
        if entry.delivery.due_at <= now {
            entry.waiting = Waiting::Ready;
            self.ready.push_back((id.to_string(), entry.admission));
            return;
        }
        entry.waiting = Waiting::Due(entry.delivery.due_at);
        self.timers.insert((entry.delivery.due_at, entry.admission));
    }

    pub(super) fn fire_timers(&mut self) {
        let now = now_ms();
        while let Some(&(at, admission)) = self.timers.first() {
            if at > now {
                return;
            }
            self.timers.remove(&(at, admission));
            let Some(id) = self.order.get(&admission).cloned() else {
                continue;
            };
            match self.entries.get(&id).map(|entry| entry.waiting) {
                Some(Waiting::SaveRetry(_)) => self.save(&id),
                Some(Waiting::Due(_)) => self.schedule(&id),
                _ => {}
            }
        }
    }

    pub(super) fn pump(&mut self) {
        while !self.stopped && !self.closed && self.sends.len() < MAX_SENDS_IN_FLIGHT {
            let Some((id, admission)) = self.ready.pop_front() else {
                return;
            };
            let commands = self.commands.clone();
            let destination = Arc::clone(&self.config.destination);
            let Some(entry) = self.current(&id, admission) else {
                continue;
            };
            if entry.waiting != Waiting::Ready {
                continue;
            }
            entry.waiting = Waiting::Sending;
            let delivery = entry.delivery.clone();
            let task = tokio::spawn(async move {
                let outcome = send(&destination, &delivery).await;
                let _ = commands.send(Command::Sent {
                    id: delivery.id,
                    admission,
                    outcome,
                });
            });
            self.sends.insert(admission, task.abort_handle());
        }
    }

    pub(super) fn sent(&mut self, id: &str, admission: u64, outcome: SendOutcome) {
        self.sends.remove(&admission);
        if outcome == SendOutcome::Gone && !self.stopped {
            self.stopped = true;
            self.config.reports.stopped(self.entries.len());
        }
        if self.closed {
            return;
        }
        let Some(entry) = self.current(id, admission) else {
            return;
        };
        if entry.waiting != Waiting::Sending {
            return;
        }
        if outcome == SendOutcome::Delivered {
            self.forget(id);
            return;
        }
        self.retry(id);
    }

    fn retry(&mut self, id: &str) {
        let Some(entry) = self.entries.get_mut(id) else {
            return;
        };
        let failed_tries = entry.delivery.failed_tries + 1;
        let delay = usize::try_from(failed_tries - 1)
            .ok()
            .and_then(|at| RETRY_DELAYS_MS.get(at))
            .copied();
        let Some(delay) = delay else {
            if let Some(entry) = self.forget(id) {
                self.config
                    .reports
                    .retries_exhausted(&entry.delivery, failed_tries);
            }
            return;
        };
        let jitter = 1.0 + random_fraction() * MAX_RETRY_JITTER_FRACTION;
        entry.delivery.failed_tries = failed_tries;
        entry.delivery.due_at = now_ms() + (delay as f64 * jitter).round() as u64;
        self.save(id);
    }
}
