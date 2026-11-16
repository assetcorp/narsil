use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use tokio::time::Instant;

use crate::constants::{CONNECTION_IDLE_TIMEOUT_MS, MIN_BODY_BYTES_PER_IDLE_TIMEOUT};

pub(crate) enum NextChunk {
    Data(Bytes),
    End,
    Broken,
}

pub(crate) struct BodyPace {
    deadline: Instant,
    received_since_reset: u64,
}

fn idle_timeout() -> Duration {
    Duration::from_millis(CONNECTION_IDLE_TIMEOUT_MS)
}

impl BodyPace {
    pub(crate) fn new() -> BodyPace {
        BodyPace {
            deadline: Instant::now() + idle_timeout(),
            received_since_reset: 0,
        }
    }

    pub(crate) async fn next_chunk(&mut self, body: &mut Incoming) -> NextChunk {
        loop {
            let Ok(frame) = tokio::time::timeout_at(self.deadline, body.frame()).await else {
                return NextChunk::Broken;
            };
            let Some(frame) = frame else {
                return NextChunk::End;
            };
            let Ok(frame) = frame else {
                return NextChunk::Broken;
            };
            let Ok(chunk) = frame.into_data() else {
                continue;
            };
            self.received_since_reset =
                self.received_since_reset.saturating_add(chunk.len() as u64);
            if self.received_since_reset >= MIN_BODY_BYTES_PER_IDLE_TIMEOUT {
                self.received_since_reset = 0;
                self.deadline = Instant::now() + idle_timeout();
            }
            return NextChunk::Data(chunk);
        }
    }
}
