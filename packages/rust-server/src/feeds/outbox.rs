use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::watch;
use tokio::time::Instant;

use super::constants::TIMER_DELAY_LIMIT_MS;
use super::limits::ByteBudget;
use super::socket::FeedSocket;

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1_000.0)
}

pub(crate) struct Outbox {
    pub(crate) socket: FeedSocket,
    budget: Arc<ByteBudget>,
    budget_freed: watch::Receiver<u64>,
    charged: u64,
    waiting_for_budget: bool,
    closed: bool,
    expires_at: Option<f64>,
}

impl Outbox {
    pub(crate) fn new(
        socket: FeedSocket,
        budget: Arc<ByteBudget>,
        expires_at: Option<f64>,
    ) -> Outbox {
        let budget_freed = budget.watch_freed();
        Outbox {
            socket,
            budget,
            budget_freed,
            charged: 0,
            waiting_for_budget: false,
            closed: false,
            expires_at,
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed
    }

    pub(crate) fn expired(&self) -> bool {
        self.expires_at
            .is_some_and(|expires_at| expires_at - now_ms() <= 0.0)
    }

    pub(crate) fn expiry_deadline(&self) -> Option<Instant> {
        let remaining = self.expires_at? - now_ms();
        let wait = remaining.clamp(0.0, TIMER_DELAY_LIMIT_MS as f64).ceil() as u64;
        Some(Instant::now() + Duration::from_millis(wait))
    }

    pub(crate) fn has_charge(&self) -> bool {
        self.charged > 0
    }

    pub(crate) fn send(&mut self, bytes: Vec<u8>) {
        if self.closed || self.expired() {
            return;
        }
        self.socket.send(bytes);
        self.settle();
    }

    pub(crate) fn settle(&mut self) {
        let now = if self.closed {
            0
        } else {
            self.socket.buffered_amount()
        };
        if now < self.charged {
            self.budget.give(self.charged - now);
            self.charged = now;
        }
    }

    pub(crate) fn charge(&mut self, bytes: u64) -> bool {
        self.budget_freed.borrow_and_update();
        if self.budget.take(bytes) {
            self.charged = self.charged.saturating_add(bytes);
            return true;
        }
        self.waiting_for_budget = true;
        false
    }

    pub(crate) fn waits_for_budget(&self) -> bool {
        self.waiting_for_budget && !self.closed
    }

    pub(crate) fn budget_signal(&self) -> watch::Receiver<u64> {
        self.budget_freed.clone()
    }

    pub(crate) fn stop_waiting_for_budget(&mut self) {
        self.waiting_for_budget = false;
    }

    pub(crate) fn close(&mut self, code: u16, reason: &str) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.release();
        self.socket.close(code, reason);
    }

    pub(crate) fn end_quietly(&mut self) {
        self.closed = true;
        self.release();
    }

    fn release(&mut self) {
        self.budget.give(self.charged);
        self.charged = 0;
    }
}

impl Drop for Outbox {
    fn drop(&mut self) {
        self.release();
    }
}

pub(crate) struct Window {
    limit: u64,
    unacked_bytes: u64,
    queues: Vec<VecDeque<(u64, u64)>>,
}

impl Window {
    pub(crate) fn new(limit: u64, partitions: usize) -> Window {
        Window {
            limit,
            unacked_bytes: 0,
            queues: (0..partitions).map(|_| VecDeque::new()).collect(),
        }
    }

    pub(crate) fn allows(&self, next: u64) -> bool {
        self.unacked_bytes == 0 || self.unacked_bytes.saturating_add(next) <= self.limit
    }

    pub(crate) fn room(&self) -> u64 {
        if self.unacked_bytes == 0 {
            self.limit
        } else {
            self.limit.saturating_sub(self.unacked_bytes)
        }
    }

    pub(crate) fn record(&mut self, partition: usize, seq_no: u64, bytes: u64) {
        if let Some(queue) = self.queues.get_mut(partition) {
            queue.push_back((seq_no, bytes));
            self.unacked_bytes = self.unacked_bytes.saturating_add(bytes);
        }
    }

    pub(crate) fn release_through(&mut self, partition: usize, seq_no: u64) {
        let Some(queue) = self.queues.get_mut(partition) else {
            return;
        };
        while let Some((sent, bytes)) = queue.front().copied() {
            if sent > seq_no {
                break;
            }
            queue.pop_front();
            self.unacked_bytes = self.unacked_bytes.saturating_sub(bytes);
        }
    }
}
