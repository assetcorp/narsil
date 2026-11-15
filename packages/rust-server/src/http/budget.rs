use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use narsil::{Map, Value};

use crate::errors::{ServerError, server_codes};

const REQUEST_BYTES_IN_FLIGHT_REASON: &str = "request_bytes_in_flight";

pub(crate) struct BodyBudget {
    in_flight: AtomicU64,
    limit_bytes: u64,
}

impl BodyBudget {
    pub(crate) fn new(limit_bytes: u64) -> Arc<BodyBudget> {
        Arc::new(BodyBudget {
            in_flight: AtomicU64::new(0),
            limit_bytes,
        })
    }

    pub(crate) fn hold(self: &Arc<BodyBudget>) -> BodyHold {
        BodyHold {
            budget: Arc::clone(self),
            held: 0,
        }
    }
}

pub(crate) struct BodyHold {
    budget: Arc<BodyBudget>,
    held: u64,
}

impl BodyHold {
    pub(crate) fn bytes(&self) -> u64 {
        self.held
    }

    pub(crate) fn grow(&mut self, bytes: u64) -> Result<(), ServerError> {
        if bytes == 0 {
            return Ok(());
        }
        let total = self
            .budget
            .in_flight
            .fetch_add(bytes, Ordering::AcqRel)
            .saturating_add(bytes);
        let others = total.saturating_sub(self.held).saturating_sub(bytes);
        if others > 0 && total > self.budget.limit_bytes {
            self.budget.in_flight.fetch_sub(bytes, Ordering::AcqRel);
            return Err(body_bytes_refusal(
                self.held + bytes,
                others,
                self.budget.limit_bytes,
            ));
        }
        self.held += bytes;
        Ok(())
    }
}

impl Drop for BodyHold {
    fn drop(&mut self) {
        if self.held > 0 {
            self.budget.in_flight.fetch_sub(self.held, Ordering::AcqRel);
        }
    }
}

fn body_bytes_refusal(request_bytes: u64, in_flight_bytes: u64, limit_bytes: u64) -> ServerError {
    let mut details = Map::new();
    details.insert(
        "reason",
        Value::String(REQUEST_BYTES_IN_FLIGHT_REASON.to_string()),
    );
    details.insert("requestBytes", Value::Number(request_bytes as f64));
    details.insert("inFlightBytes", Value::Number(in_flight_bytes as f64));
    details.insert("limitBytes", Value::Number(limit_bytes as f64));
    ServerError::new(
        429,
        server_codes::TOO_MANY_REQUESTS,
        format!(
            "The server is holding {in_flight_bytes} bytes of other request bodies, and this body's {request_bytes} bytes would take the total past its limit of {limit_bytes} bytes. Retry once the requests in progress finish."
        ),
    )
    .with_details(details)
}

pub(crate) struct RequestGate {
    in_flight: AtomicUsize,
    max: usize,
}

pub(crate) struct GatePass {
    gate: Arc<RequestGate>,
}

impl RequestGate {
    pub(crate) fn new(max: usize) -> Arc<RequestGate> {
        Arc::new(RequestGate {
            in_flight: AtomicUsize::new(0),
            max,
        })
    }

    pub(crate) fn try_acquire(self: &Arc<RequestGate>) -> Option<GatePass> {
        if self.max > 0 {
            let taken = self.in_flight.fetch_add(1, Ordering::AcqRel);
            if taken >= self.max {
                self.in_flight.fetch_sub(1, Ordering::AcqRel);
                return None;
            }
        }
        Some(GatePass {
            gate: Arc::clone(self),
        })
    }
}

impl Drop for GatePass {
    fn drop(&mut self) {
        if self.gate.max > 0 {
            self.gate.in_flight.fetch_sub(1, Ordering::AcqRel);
        }
    }
}
