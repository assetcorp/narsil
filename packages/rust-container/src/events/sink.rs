use std::collections::BTreeSet;
use std::sync::Arc;

use narsil::Value;

use super::body::{delivery_body, now_ms};
use super::output::Output;
use crate::webhooks::QueueHandle;

struct Delivered {
    queue: QueueHandle,
    types: Option<BTreeSet<String>>,
}

#[derive(Clone)]
pub struct EventSink {
    output: Output,
    delivered: Option<Arc<Delivered>>,
}

impl EventSink {
    pub fn new(
        output: Output,
        queue: Option<QueueHandle>,
        types: Option<BTreeSet<String>>,
    ) -> EventSink {
        EventSink {
            output,
            delivered: queue.map(|queue| Arc::new(Delivered { queue, types })),
        }
    }

    pub fn publish(&self, event_type: &str, data: Value) {
        let body = delivery_body(event_type, data, now_ms());
        let Some(delivered) = &self.delivered else {
            self.output.event(body);
            return;
        };
        self.output.event(body.clone());
        if delivered
            .types
            .as_ref()
            .is_none_or(|types| types.contains(event_type))
        {
            delivered.queue.enqueue(event_type.to_string(), body);
        }
    }
}
