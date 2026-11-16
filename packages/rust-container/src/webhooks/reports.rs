use narsil::Value;

use super::constants::GONE_STATUS;
use super::delivery::Delivery;
use crate::events::Output;
use crate::events::body::{delivery_body, now_ms, object};
use crate::events::types::{
    WEBHOOK_DROPPED_TYPE, WEBHOOK_PERSISTENCE_ERROR_TYPE, WEBHOOK_STOPPED_TYPE,
};

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

fn count(value: u64) -> Value {
    Value::Number(value as f64)
}

#[derive(Clone)]
pub struct QueueReports {
    output: Output,
}

impl QueueReports {
    pub fn new(output: Output) -> QueueReports {
        QueueReports { output }
    }

    fn report(&self, event_type: &str, data: Value) {
        self.output.event(delivery_body(event_type, data, now_ms()));
    }

    pub fn dropped_before_start(&self, dropped: u64) {
        let data = object(vec![
            ("reason", text("queueFull")),
            ("dropped", count(dropped)),
        ]);
        self.report(WEBHOOK_DROPPED_TYPE, data);
    }

    pub fn dropped_as_oldest(&self, delivery: &Delivery, dropped: u64) {
        let data = object(vec![
            ("reason", text("queueFull")),
            ("deliveryId", text(&delivery.id)),
            ("eventType", text(&delivery.event_type)),
            ("dropped", count(dropped)),
        ]);
        self.report(WEBHOOK_DROPPED_TYPE, data);
    }

    pub fn retries_exhausted(&self, delivery: &Delivery, tries: u64) {
        let data = object(vec![
            ("reason", text("retriesExhausted")),
            ("deliveryId", text(&delivery.id)),
            ("eventType", text(&delivery.event_type)),
            ("tries", count(tries)),
        ]);
        self.report(WEBHOOK_DROPPED_TYPE, data);
    }

    pub fn stopped(&self, queued: usize) {
        let data = object(vec![
            ("reason", text("gone")),
            ("status", Value::Number(f64::from(GONE_STATUS))),
            ("queued", Value::Number(queued as f64)),
        ]);
        self.report(WEBHOOK_STOPPED_TYPE, data);
    }

    pub fn persistence_error(&self, operation: &str, id: &str) {
        let data = object(vec![
            ("operation", text(operation)),
            ("deliveryId", text(id)),
        ]);
        self.report(WEBHOOK_PERSISTENCE_ERROR_TYPE, data);
    }
}
