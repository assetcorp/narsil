use super::super::constants::MAX_QUEUED_DELIVERIES;
use super::super::delivery::{Delivery, random_delivery_id};
use super::{Command, Entry, Queue, Waiting};
use crate::events::body::now_ms;

impl Queue {
    pub(super) fn start(&mut self, mut loaded: Vec<Delivery>) {
        if self.started || self.closed {
            return;
        }
        loaded.sort_by(|left, right| {
            left.sequence
                .cmp(&right.sequence)
                .then(left.enqueued_at.cmp(&right.enqueued_at))
        });
        for delivery in loaded {
            let wanted = self
                .config
                .events
                .as_ref()
                .is_none_or(|events| events.contains(&delivery.event_type));
            if !wanted {
                self.remove_from_store(&delivery.id);
                continue;
            }
            self.next_sequence = self.next_sequence.max(delivery.sequence + 1);
            self.admit(delivery, false);
        }
        self.started = true;
        for (event_type, body) in self.deferred.take() {
            self.enqueue(event_type, body);
        }
    }

    pub(super) fn enqueue(&mut self, event_type: String, body: String) {
        if self.closed {
            return;
        }
        if !self.started {
            if let Some(dropped) = self.deferred.push(event_type, body) {
                self.config.reports.dropped_before_start(dropped);
            }
            return;
        }
        let Some(id) = random_delivery_id() else {
            return;
        };
        let now = now_ms();
        let delivery = Delivery {
            id,
            event_type,
            body,
            enqueued_at: now,
            sequence: self.next_sequence,
            failed_tries: 0,
            due_at: now,
        };
        self.next_sequence += 1;
        self.admit(delivery, true);
    }

    fn admit(&mut self, delivery: Delivery, persist: bool) {
        while self.entries.len() >= MAX_QUEUED_DELIVERIES {
            self.drop_oldest();
        }
        let admission = self.next_admission;
        self.next_admission += 1;
        let id = delivery.id.clone();
        self.order.insert(admission, id.clone());
        let waiting = Waiting::Saving;
        self.entries.insert(
            id.clone(),
            Entry {
                delivery,
                admission,
                waiting,
            },
        );
        if persist {
            self.save(&id);
        } else {
            self.schedule(&id);
        }
    }

    fn drop_oldest(&mut self) {
        let Some(id) = self.order.values().next().cloned() else {
            return;
        };
        let Some(entry) = self.forget(&id) else {
            return;
        };
        self.dropped += 1;
        self.config
            .reports
            .dropped_as_oldest(&entry.delivery, self.dropped);
    }

    pub(super) fn forget(&mut self, id: &str) -> Option<Entry> {
        let entry = self.entries.remove(id)?;
        if let Waiting::Due(at) | Waiting::SaveRetry(at) = entry.waiting {
            self.timers.remove(&(at, entry.admission));
        }
        if entry.waiting == Waiting::Ready
            && let Some(at) = self
                .ready
                .iter()
                .position(|(_, admission)| *admission == entry.admission)
        {
            self.ready.remove(at);
        }
        self.order.remove(&entry.admission);
        self.remove_from_store(id);
        Some(entry)
    }

    fn remove_from_store(&self, id: &str) {
        let commands = self.commands.clone();
        let owner = id.to_string();
        self.config.store.remove(id, move |written| {
            let _ = commands.send(Command::Removed { id: owner, written });
        });
    }
}
