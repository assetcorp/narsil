use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use narsil::{
    Change, ChangeFeed, ChangeGroup, ChangePosition, ChangeType, ChangesEvent, ChangesRequest,
    ChangesSetting, ChangesSubscribed, DurabilityConfig, IndexConfig, Map, Narsil, NarsilConfig,
    PartitionConfig, ResyncReason, Value, parse_json,
};

pub const INDEX: &str = "orders";
pub const FEED_WAIT: Duration = Duration::from_secs(30);
const MAX_TEST_PARTITIONS: u64 = 8;

pub type Document = BTreeMap<String, Value>;
pub type Documents = BTreeMap<String, Document>;

pub fn log_config(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            segment_max_bytes: Some(4_096),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

pub fn order_index() -> IndexConfig {
    let schema = parse_json(
        r#"{"title": "string", "status": "enum", "total": "number", "embedding": "vector[2]"}"#,
    )
    .expect("the schema parses");
    IndexConfig {
        schema,
        partitions: Some(PartitionConfig {
            max_partitions: Some(MAX_TEST_PARTITIONS),
            ..PartitionConfig::default()
        }),
        ..IndexConfig::default()
    }
}

pub fn order(title: &str, status: &str, total: f64) -> Map {
    let mut order = Map::new();
    order.insert("title", Value::String(title.to_string()));
    order.insert("status", Value::String(status.to_string()));
    order.insert("total", Value::Number(total));
    order.insert(
        "embedding",
        Value::Array(vec![Value::Number(total / 4.0), Value::Number(0.5)]),
    );
    order
}

pub fn plain(document: &Map) -> Document {
    document
        .iter()
        .filter(|(key, _)| key.as_str() != "id")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub fn capture(previous_document: bool) -> ChangesSetting {
    ChangesSetting {
        enabled: true,
        previous_document,
        history_max_age_ms: None,
        history_max_bytes: None,
    }
}

pub fn open_orders(root: &Path, partitions: usize, setting: &ChangesSetting) -> Narsil {
    let narsil = Narsil::open(log_config(root)).expect("the engine opens");
    narsil
        .create_index(INDEX, order_index())
        .expect("the index is created");
    if partitions > 1 {
        narsil
            .rebalance(INDEX, partitions)
            .expect("the partitions spread");
    }
    narsil
        .update_changes(INDEX, setting)
        .expect("capture turns on");
    narsil
}

#[derive(Default)]
pub struct Oracle {
    pub documents: Documents,
}

impl Oracle {
    pub fn insert(&mut self, narsil: &Narsil, id: &str, document: Map) {
        narsil
            .insert(INDEX, document.clone(), Some(id))
            .expect("the insert applies");
        self.documents.insert(id.to_string(), plain(&document));
    }

    pub fn update(&mut self, narsil: &Narsil, id: &str, document: Map) {
        narsil
            .update(INDEX, id, document.clone())
            .expect("the update applies");
        self.documents.insert(id.to_string(), plain(&document));
    }

    pub fn remove(&mut self, narsil: &Narsil, id: &str) {
        narsil.remove(INDEX, id).expect("the removal applies");
        self.documents.remove(id);
    }

    pub fn matching(&self, status: &str) -> Documents {
        self.documents
            .iter()
            .filter(|(_, document)| document.get("status") == Some(&Value::String(status.into())))
            .map(|(id, document)| (id.clone(), document.clone()))
            .collect()
    }
}

pub struct Subscriber {
    pub copy: Documents,
    pub epoch: String,
    pub positions: BTreeMap<u32, u64>,
    pub strict: bool,
    pub applied: Vec<Change>,
}

impl Subscriber {
    pub fn from_export(narsil: &Narsil, strict: bool) -> Subscriber {
        let export = read_export(narsil);
        Subscriber {
            copy: export.documents,
            epoch: export
                .epoch
                .expect("an index with capture on exports its epoch"),
            positions: export.positions,
            strict,
            applied: Vec::new(),
        }
    }

    pub fn request(&self) -> ChangesRequest {
        ChangesRequest {
            epoch: Some(self.epoch.clone()),
            positions: Some(
                self.positions
                    .iter()
                    .map(|(partition_id, seq_no)| ChangePosition {
                        partition_id: *partition_id,
                        seq_no: *seq_no,
                    })
                    .collect(),
            ),
            filter: None,
        }
    }

    fn apply_change(&mut self, change: &Change) {
        let held = self.copy.get(&change.document_id).cloned();
        let previous = change.previous_document.as_ref().map(plain);
        if self.strict {
            match change.change_type {
                ChangeType::Insert => assert!(
                    held.is_none(),
                    "an insert of {} reached a copy that holds it",
                    change.document_id
                ),
                ChangeType::Update => assert_eq!(
                    previous, held,
                    "the update of {} carries the document that the copy holds",
                    change.document_id
                ),
                ChangeType::Remove => assert_eq!(
                    previous, held,
                    "the removal of {} carries the document that the copy holds",
                    change.document_id
                ),
                ChangeType::Put => panic!("an index with previous documents on wrote a put"),
            }
        }
        match (&change.change_type, &change.document) {
            (ChangeType::Remove, None) => {
                self.copy.remove(&change.document_id);
            }
            (_, Some(document)) => {
                self.copy
                    .insert(change.document_id.clone(), plain(document));
            }
            (change_type, None) => panic!("a {change_type:?} change holds no document"),
        }
        self.applied.push(change.clone());
    }

    pub fn apply(&mut self, group: &ChangeGroup) {
        let saved = self
            .positions
            .get(&group.partition_id)
            .copied()
            .unwrap_or(0);
        assert!(
            group.scanned_seq_no > saved,
            "a group of partition {} moves its position from {saved} to {}",
            group.partition_id,
            group.scanned_seq_no
        );
        let mut last = saved;
        for change in &group.changes {
            assert!(
                change.seq_no > last && change.seq_no <= group.scanned_seq_no,
                "the changes of partition {} arrive in order",
                group.partition_id
            );
            last = change.seq_no;
            self.apply_change(change);
        }
        self.positions
            .insert(group.partition_id, group.scanned_seq_no);
    }

    pub fn subscribed(&mut self, subscribed: &ChangesSubscribed) {
        self.epoch = subscribed.epoch.clone();
        for position in &subscribed.positions {
            self.positions
                .insert(position.partition_id, position.seq_no);
        }
    }

    pub fn follow_to(&mut self, feed: &mut ChangeFeed, heads: &BTreeMap<u32, u64>) {
        let started = Instant::now();
        while heads.iter().any(|(partition_id, head)| {
            self.positions.get(partition_id).copied().unwrap_or(0) < *head
        }) {
            assert!(
                started.elapsed() < FEED_WAIT,
                "the feed reached {:?} of heads {heads:?}",
                self.positions
            );
            match feed.next_within(Duration::from_millis(500)) {
                Some(Ok(ChangesEvent::Changes(group))) => self.apply(&group),
                Some(Ok(ChangesEvent::Subscribed(subscribed))) => self.subscribed(&subscribed),
                Some(Ok(ChangesEvent::Resync(reason))) => {
                    panic!("the feed asked for a resync: {reason:?}")
                }
                Some(Err(error)) => panic!("the feed failed: {error}"),
                None => assert!(!feed.is_finished(), "the feed ended early"),
            }
        }
    }
}

pub fn heads_of(narsil: &Narsil) -> BTreeMap<u32, u64> {
    let mut feed = narsil
        .changes(INDEX, &ChangesRequest::default())
        .expect("a feed opens at the heads");
    match feed.next_within(FEED_WAIT) {
        Some(Ok(ChangesEvent::Subscribed(subscribed))) => subscribed
            .heads
            .iter()
            .map(|head| (head.partition_id, head.seq_no))
            .collect(),
        other => panic!("a feed opens with its subscribed event, not {other:?}"),
    }
}

pub fn first_event(feed: &mut ChangeFeed) -> ChangesEvent {
    match feed.next_within(FEED_WAIT) {
        Some(Ok(event)) => event,
        other => panic!("the feed returns its first event, not {other:?}"),
    }
}

pub fn resync_of(narsil: &Narsil, request: &ChangesRequest) -> ResyncReason {
    let mut feed = narsil.changes(INDEX, request).expect("the feed opens");
    match first_event(&mut feed) {
        ChangesEvent::Resync(reason) => {
            assert!(feed.is_finished(), "a feed ends after its resync");
            reason
        }
        other => panic!("the request calls for a resync, not {other:?}"),
    }
}

pub struct Export {
    pub epoch: Option<String>,
    pub positions: BTreeMap<u32, u64>,
    pub header_keys: Vec<String>,
    pub documents: Documents,
}

pub fn read_export(narsil: &Narsil) -> Export {
    let mut bytes = Vec::new();
    narsil
        .export_documents(INDEX, &mut bytes)
        .expect("the export writes");
    let text = String::from_utf8(bytes).expect("an export is UTF-8");
    let mut lines = text.lines();
    let Some(Value::Object(header)) = lines
        .next()
        .map(|line| parse_json(line).expect("the header parses"))
    else {
        panic!("the export holds no header");
    };
    let epoch = header
        .get("epoch")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut positions = BTreeMap::new();
    if let Some(Value::Array(listed)) = header.get("positions") {
        for position in listed {
            let Value::Object(position) = position else {
                panic!("a position is an object");
            };
            let number = |key: &str| {
                position
                    .get(key)
                    .and_then(Value::as_f64)
                    .expect("a position holds numbers")
            };
            positions.insert(number("partitionId") as u32, number("seqNo") as u64);
        }
    }
    let mut documents = Documents::new();
    for line in lines {
        let Value::Object(document) = parse_json(line).expect("a document line parses") else {
            panic!("a document line is an object");
        };
        let id = document
            .get("id")
            .and_then(Value::as_str)
            .expect("a line holds its id")
            .to_string();
        documents.insert(id, plain(&document));
    }
    Export {
        epoch,
        positions,
        header_keys: header.iter().map(|(key, _)| key.clone()).collect(),
        documents,
    }
}

pub fn files_under(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(next) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

pub fn history_files(root: &Path) -> Vec<PathBuf> {
    files_under(&root.join(INDEX).join("history"))
}
