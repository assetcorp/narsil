use std::time::Duration;

use bytes::Bytes;
use narsil::{
    Change, ChangeFeed, ChangeGroup, ChangePosition, ChangesEvent, ChangesRequest, ErrorCode,
    Filter, Map, Narsil, NarsilError, Value, encode_msgpack,
};
use tokio::time::Instant;

use super::constants::{ENTRIES_MESSAGE_LIMIT_BYTES, FEED_HEAD_RETRY_MS};
use super::core::Core;
use super::hub::{CHANGES_OFF_REASON, PREVIOUS_DOCUMENT_REQUIRED};
use super::outbox::Window;
use super::wire::{
    CLOSE_POLICY, CLOSE_RESYNC, CLOSE_SETTING, Position, SubscriberMessage, message, position_list,
    seq_nos_by_partition, subscriber_message_of,
};
use crate::search::{refused_regex_field, regex_refusal_message};

const INVALID_POSITIONS_REASON: &str = "The positions must hold each partition of the index once";

type Opened = Result<
    (
        ChangeFeed,
        Option<Result<ChangesEvent, NarsilError>>,
        Vec<String>,
    ),
    NarsilError,
>;

#[derive(Default)]
pub(crate) struct ChangesFeed {
    subscribed: bool,
    feed: Option<ChangeFeed>,
    sent: Vec<u64>,
    scanned: Vec<u64>,
    silent: Vec<u64>,
    window: Option<Window>,
}

fn seq_nos_of(positions: &[ChangePosition]) -> Vec<u64> {
    positions.iter().map(|position| position.seq_no).collect()
}

fn change_value(change: Change) -> Value {
    let mut record = Map::with_capacity(5);
    record.insert("seqNo", Value::Number(change.seq_no as f64));
    record.insert(
        "type",
        Value::String(change.change_type.as_str().to_string()),
    );
    record.insert("documentId", Value::String(change.document_id));
    if let Some(document) = change.document {
        record.insert("document", Value::Object(document));
    }
    if let Some(previous) = change.previous_document {
        record.insert("previousDocument", Value::Object(previous));
    }
    Value::Object(record)
}

fn changes_message(group: ChangeGroup) -> Option<Vec<u8>> {
    let mut record = Map::with_capacity(4);
    record.insert("type", Value::String("changes".to_string()));
    record.insert("partitionId", Value::Number(group.partition_id as f64));
    record.insert("scannedSeqNo", Value::Number(group.scanned_seq_no as f64));
    record.insert(
        "changes",
        Value::Array(group.changes.into_iter().map(change_value).collect()),
    );
    encode_msgpack(&Value::Object(record)).ok()
}

fn open(engine: &Narsil, index: &str, request: &ChangesRequest) -> Opened {
    let mut feed = engine.changes(index, request)?;
    let first = feed.next_within_bytes(Duration::ZERO, 1);
    let vector_fields = match &first {
        Some(Ok(ChangesEvent::Subscribed(_))) => engine.vector_fields(index)?,
        _ => Vec::new(),
    };
    Ok((feed, first, vector_fields))
}

fn undurable(engine: &Narsil, index: &str, partitions: usize) -> bool {
    (0..partitions as u32).any(|partition| {
        engine
            .sync_bounds(index, partition)
            .is_ok_and(|bounds| bounds.highest_seq_no > bounds.head)
    })
}

impl ChangesFeed {
    pub(crate) fn subscribed(&self) -> bool {
        self.subscribed
    }

    pub(crate) async fn on_message(&mut self, core: &mut Core, bytes: Bytes) {
        let Some(decoded) = core.decode(bytes, subscriber_message_of).await else {
            return;
        };
        let Some(message) = decoded else {
            core.close(CLOSE_POLICY, "invalid message");
            return;
        };
        match message {
            SubscriberMessage::Subscribe { .. } if self.subscribed => {
                core.close(CLOSE_POLICY, "subscribe after the first message");
            }
            SubscriberMessage::Subscribe { resume, filter } => {
                self.subscribe(core, resume, filter).await;
            }
            SubscriberMessage::Ack(_) if !self.subscribed => {
                core.close(CLOSE_POLICY, "subscribe must come first");
            }
            SubscriberMessage::Ack(positions) => self.acknowledge(core, &positions).await,
        }
    }

    fn close_over(core: &mut Core, error: &NarsilError) {
        match error.code() {
            ErrorCode::CHANGES_PREVIOUS_DOCUMENT_REQUIRED => {
                core.close(CLOSE_SETTING, PREVIOUS_DOCUMENT_REQUIRED);
            }
            ErrorCode::CHANGES_NOT_ENABLED | ErrorCode::INDEX_NOT_FOUND => {
                core.close(CLOSE_RESYNC, CHANGES_OFF_REASON);
            }
            ErrorCode::CHANGES_INVALID_POSITIONS => {
                core.close(CLOSE_POLICY, INVALID_POSITIONS_REASON);
            }
            ErrorCode::SEARCH_INVALID_FILTER | ErrorCode::SEARCH_INVALID_FIELD => {
                core.close(CLOSE_POLICY, error.message());
            }
            _ => core.fail(error, CHANGES_OFF_REASON),
        }
    }

    async fn subscribe(
        &mut self,
        core: &mut Core,
        resume: Option<(String, Vec<Position>)>,
        filter: Option<Value>,
    ) {
        if let Some(field_path) = filter
            .as_ref()
            .and_then(|filter| refused_regex_field(filter, core.hub.allow_regex))
        {
            return core.close(CLOSE_POLICY, &regex_refusal_message(&field_path));
        }
        let filtered = filter.is_some();
        let (epoch, positions) = match resume {
            Some((epoch, positions)) => (Some(epoch), Some(positions)),
            None => (None, None),
        };
        let request = ChangesRequest {
            epoch,
            positions: positions.map(|positions| {
                positions
                    .iter()
                    .map(|position| ChangePosition {
                        partition_id: position.partition_id,
                        seq_no: position.seq_no,
                    })
                    .collect()
            }),
            filter: filter.map(Filter::from_value),
        };
        let index = core.index.clone();
        let Some(opened) = core
            .catch_up(move |engine| open(engine, &index, &request))
            .await
        else {
            return;
        };
        let (feed, first, vector_fields) = match opened {
            Ok(opened) => opened,
            Err(error) => return Self::close_over(core, &error),
        };
        let subscribed = match first {
            Some(Ok(ChangesEvent::Subscribed(subscribed))) => subscribed,
            Some(Ok(ChangesEvent::Resync(reason))) => return core.resync(reason.as_str()),
            Some(Err(error)) => return Self::close_over(core, &error),
            _ => return core.fail_quietly(),
        };
        if core.closed() {
            return;
        }
        let count = subscribed.partition_count as usize;
        let window_bytes = core.hub.options.window_bytes;
        let starts = seq_nos_of(&subscribed.positions);
        let Some(answer) = message(
            "subscribed",
            vec![
                ("epoch", Value::String(subscribed.epoch.clone())),
                ("partitionCount", Value::Number(count as f64)),
                ("positions", position_list(&starts)),
                ("heads", position_list(&seq_nos_of(&subscribed.heads))),
                ("bytesBehind", Value::Number(subscribed.bytes_behind as f64)),
                ("windowBytes", Value::Number(window_bytes as f64)),
                (
                    "previousDocument",
                    Value::Bool(subscribed.previous_document),
                ),
                (
                    "vectorFields",
                    Value::Array(vector_fields.into_iter().map(Value::String).collect()),
                ),
            ],
        ) else {
            return core.fail_quietly();
        };
        if filtered {
            core.signals.mark_filtered();
        }
        self.feed = Some(feed);
        self.sent = starts.clone();
        self.scanned = starts;
        self.silent = vec![0; count];
        self.window = Some(Window::new(window_bytes, count));
        self.subscribed = true;
        core.outbox.send(answer);
        self.pump(core).await;
    }

    async fn acknowledge(&mut self, core: &mut Core, positions: &[Position]) {
        let Some(seq_nos) = seq_nos_by_partition(positions, self.sent.len()) else {
            return core.close(CLOSE_POLICY, "positions must name each partition once");
        };
        if seq_nos
            .iter()
            .zip(&self.sent)
            .any(|(acked, sent)| acked > sent)
        {
            return core.close(CLOSE_POLICY, "acknowledgement above a sent position");
        }
        if let Some(window) = self.window.as_mut() {
            for (partition, seq_no) in seq_nos.iter().enumerate() {
                window.release_through(partition, *seq_no);
            }
        }
        self.pump(core).await;
    }

    pub(crate) async fn pump(&mut self, core: &mut Core) {
        let Some(mut feed) = self.feed.take() else {
            return;
        };
        while let Some(window) = self.window.as_ref() {
            if core.closed() || !window.allows(1) || core.outbox.has_charge() {
                break;
            }
            let budget = window.room().clamp(1, ENTRIES_MESSAGE_LIMIT_BYTES) as usize;
            let Some((returned, event)) = core
                .catch_up(move |_| {
                    let event = feed.next_within_bytes(Duration::ZERO, budget);
                    (feed, event)
                })
                .await
            else {
                return;
            };
            feed = returned;
            match event {
                None => break,
                Some(Err(error)) => {
                    Self::close_over(core, &error);
                    break;
                }
                Some(Ok(ChangesEvent::Resync(reason))) => {
                    core.resync(reason.as_str());
                    break;
                }
                Some(Ok(ChangesEvent::Subscribed(_))) => {}
                Some(Ok(ChangesEvent::Changes(group))) => {
                    if !self.send_group(core, &mut feed, group) {
                        break;
                    }
                }
            }
        }
        self.feed = Some(feed);
        if core.closed() || core.retry_at.is_some() {
            return;
        }
        let (index, count) = (core.index.clone(), self.sent.len());
        if let Some(true) = core
            .blocking(move |engine| undurable(engine, &index, count))
            .await
        {
            core.retry_at = Some(Instant::now() + Duration::from_millis(FEED_HEAD_RETRY_MS));
        }
    }

    fn send_group(&mut self, core: &mut Core, feed: &mut ChangeFeed, group: ChangeGroup) -> bool {
        let partition = group.partition_id as usize;
        let window_bytes = core.hub.options.window_bytes;
        let (Some(window), Some(silent), Some(scanned), Some(sent)) = (
            self.window.as_mut(),
            self.silent.get_mut(partition),
            self.scanned.get_mut(partition),
            self.sent.get_mut(partition),
        ) else {
            core.fail_quietly();
            return false;
        };
        let scanned_seq_no = group.scanned_seq_no;
        if group.changes.is_empty() && silent.saturating_add(group.scanned_bytes) < window_bytes {
            *silent = silent.saturating_add(group.scanned_bytes);
            *scanned = scanned_seq_no;
            return true;
        }
        let Some(message) = changes_message(group) else {
            core.fail_quietly();
            return false;
        };
        let length = message.len() as u64;
        if !window.allows(length) || !core.outbox.charge(length) {
            feed.rewind(ChangePosition {
                partition_id: partition as u32,
                seq_no: *scanned,
            });
            return false;
        }
        window.record(partition, scanned_seq_no, length);
        *silent = 0;
        *sent = scanned_seq_no;
        *scanned = scanned_seq_no;
        core.outbox.send(message);
        true
    }
}
