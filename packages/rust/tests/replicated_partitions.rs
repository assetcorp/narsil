mod support;

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use narsil::replication::{
    CopyPosition, EntryOperation, HeldTerm, PartitionCopies, PrimaryLimits, PrimaryWrite,
    ReplicatedEntry, WriteRecord,
};
use narsil::{
    DurabilityConfig, DurabilityMode, ErrorCode, IndexConfig, Map, Narsil, NarsilConfig, Storage,
    Value, decode_msgpack,
};
use support::{ScratchDirectory, WHOLE_DOCUMENT};

const INDEX: &str = "orders";
const UUID: &str = "0190a0b0-0000-7000-8000-000000000270";
const PARTITIONS: u32 = 3;
const ROUNDS: u64 = 240;
const ROUNDS_PER_RESTART: u64 = 37;
const ROUNDS_PER_TERM: u64 = 53;
const DIMENSION: usize = 3;
const TORN_SEGMENT_MAX_BYTES: u64 = 10_000;
const TORN_ITEM_CHARACTERS: usize = 4_000;

type Held = BTreeMap<String, (Map, WriteRecord)>;

struct Seeded(u64);

impl Seeded {
    fn below(&mut self, limit: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % limit
    }
}

fn partition_of(id: &str) -> u32 {
    let mut hash = 0x811C_9DC5_u32;
    for byte in id.bytes() {
        hash = (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193);
    }
    hash % PARTITIONS
}

fn engine(root: &Path) -> Narsil {
    Narsil::open(NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            checkpoint_mutation_threshold: Some(7),
            compaction_threshold: Some(2),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    })
    .expect("the engine opens")
}

fn index_config(text: Storage) -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("item", Value::from("string"));
    schema.insert("total", Value::from("number"));
    schema.insert("embedding", Value::from(format!("vector[{DIMENSION}]")));
    IndexConfig {
        text_storage: Some(text),
        ..IndexConfig::new(Value::Object(schema))
    }
}

fn order(id: &str, round: u64) -> Map {
    let mut document = Map::new();
    document.insert("id", Value::from(id));
    document.insert("item", Value::from(format!("crate of apples {round}")));
    document.insert("total", Value::from(round));
    document.insert(
        "embedding",
        Value::Array(
            (0..DIMENSION as u64)
                .map(|at| Value::from(round + at + 1))
                .collect(),
        ),
    );
    document
}

struct Copy {
    root: ScratchDirectory,
    engine: Option<Narsil>,
}

impl Copy {
    fn new(label: &str, text: Storage) -> Copy {
        let root = ScratchDirectory::new(label);
        let engine = engine(root.path());
        PartitionCopies::new(&engine)
            .create_index(INDEX, index_config(text), UUID, PARTITIONS)
            .expect("the copy is created");
        Copy {
            root,
            engine: Some(engine),
        }
    }

    fn engine(&self) -> &Narsil {
        self.engine.as_ref().expect("the engine is open")
    }

    fn copies(&self) -> PartitionCopies<'_> {
        PartitionCopies::new(self.engine())
    }

    fn restart(&mut self) {
        let closing = self.engine.take().expect("the engine is open");
        closing.shutdown().expect("the engine shuts down");
        drop(closing);
        self.engine = Some(engine(self.root.path()));
    }

    fn assert_holds(&self, held: &Held, reached: &[CopyPosition], starts: &[Vec<(u64, u64)>]) {
        let copies = self.copies();
        assert_eq!(copies.index_uuid(INDEX).unwrap().as_deref(), Some(UUID));
        for partition in 0..PARTITIONS {
            let at = partition as usize;
            assert_eq!(copies.position(INDEX, partition).unwrap(), reached[at]);
            for &(term, first) in &starts[at] {
                assert_eq!(
                    copies.held_term(INDEX, partition, first).unwrap(),
                    HeldTerm::Held(term),
                );
            }
            assert_eq!(
                copies
                    .held_term(INDEX, partition, reached[at].seq_no + 1)
                    .unwrap(),
                HeldTerm::Absent,
            );
        }
        for number in 0..20 {
            let id = format!("order-{number}");
            let stored = self
                .engine()
                .get_with(INDEX, &id, Some(&WHOLE_DOCUMENT))
                .expect("the read answers");
            let record = copies
                .write_record(INDEX, partition_of(&id), &id)
                .expect("the record is read");
            assert_eq!(stored, held.get(&id).map(|(document, _)| document.clone()));
            assert_eq!(record, held.get(&id).map(|(_, record)| *record));
        }
    }
}

fn follows(primary: &Copy, replica: &Copy, partition: u32, term: u64, write: PrimaryWrite) -> bool {
    let run = primary
        .copies()
        .write(
            INDEX,
            partition,
            term,
            vec![write],
            PrimaryLimits {
                records_previous_documents: true,
                max_entry_bytes: 1 << 20,
            },
        )
        .expect("the primary takes the write");
    assert_eq!(run.failure, None);
    let written = run.outcomes.into_iter().next().expect("one outcome").ok();
    let Some(written) = written else {
        return false;
    };
    let applied = replica
        .copies()
        .append(INDEX, partition, std::slice::from_ref(&written.entry))
        .expect("the replica takes the entry");
    assert_eq!((applied.applied, applied.failure), (1, None));
    true
}

#[test]
fn both_copies_keep_assigned_numbers_terms_and_records_across_restarts() {
    for text in [Storage::Memory, Storage::Disk] {
        let mut primary = Copy::new("assigned-primary", text);
        let mut replica = Copy::new("assigned-replica", text);
        let mut seeded = Seeded(0x2545_F491_4F6C_DD1D);
        let mut held = Held::new();
        let mut reached = vec![CopyPosition::default(); PARTITIONS as usize];
        let mut starts = vec![Vec::new(); PARTITIONS as usize];
        for round in 1..=ROUNDS {
            let id = format!("order-{}", seeded.below(20));
            let partition = partition_of(&id);
            let term = 3 + round / ROUNDS_PER_TERM;
            let removes = held.contains_key(&id) && seeded.below(4) == 0;
            let write = match (held.contains_key(&id), removes) {
                (false, _) => PrimaryWrite::Insert {
                    document_id: id.clone(),
                    document: order(&id, round),
                },
                (true, false) => PrimaryWrite::Update {
                    document_id: id.clone(),
                    document: order(&id, round),
                },
                (true, true) => PrimaryWrite::Remove {
                    document_id: id.clone(),
                },
            };
            assert!(follows(&primary, &replica, partition, term, write));
            let position = &mut reached[partition as usize];
            if position.primary_term != term {
                starts[partition as usize].push((term, position.seq_no + 1));
            }
            *position = CopyPosition {
                seq_no: position.seq_no + 1,
                primary_term: term,
            };
            let record = WriteRecord {
                seq_no: position.seq_no,
                primary_term: term,
            };
            if removes {
                held.remove(&id);
            } else {
                held.insert(id.clone(), (order(&id, round), record));
            }
            if round % ROUNDS_PER_RESTART == 0 {
                primary.restart();
                replica.restart();
                primary.assert_holds(&held, &reached, &starts);
                replica.assert_holds(&held, &reached, &starts);
            }
        }
        primary.assert_holds(&held, &reached, &starts);
        replica.assert_holds(&held, &reached, &starts);
    }
}

fn entry(id: &str, seq_no: u64, primary_term: u64, document: Option<Vec<u8>>) -> ReplicatedEntry {
    ReplicatedEntry {
        seq_no,
        primary_term,
        operation: match document {
            Some(_) => EntryOperation::Index,
            None => EntryOperation::Delete,
        },
        document_id: id.to_string(),
        document,
        previous_document: None,
    }
}

fn encoded(document: &Map) -> Vec<u8> {
    narsil::encode_msgpack(&Value::Object(document.clone())).expect("the document encodes")
}

#[test]
fn a_hostile_run_applies_only_its_valid_prefix() {
    let mut copy = Copy::new("assigned-hostile", Storage::Memory);
    let id = "order-1";
    let partition = partition_of(id);
    let elsewhere = (0..20)
        .map(|number| format!("order-{number}"))
        .find(|other| partition_of(other) != partition)
        .expect("another partition holds an order");
    let good = encoded(&order(id, 1));
    let mut wrong_type = order(id, 2);
    wrong_type.insert("total", Value::from("many"));
    let refused = [
        entry(id, 5, 4, Some(good.clone())),
        entry(id, 2, 1, Some(good.clone())),
        entry(id, 2, 4, Some(vec![0xC1, 0xFF])),
        entry(id, 2, 4, Some(encoded(&wrong_type))),
        entry(&elsewhere, 2, 4, Some(good.clone())),
    ];
    let first = entry(id, 1, 3, Some(good));
    let applied = copy
        .copies()
        .append(INDEX, partition, &[first])
        .expect("the first entry applies");
    assert_eq!((applied.applied, applied.failure), (1, None));
    for bad in refused {
        let outcome = copy
            .copies()
            .append(INDEX, partition, std::slice::from_ref(&bad))
            .expect("the run answers");
        assert_eq!(outcome.applied, 0, "{bad:?}");
        assert!(outcome.failure.is_some(), "{bad:?}");
    }
    let expected = CopyPosition {
        seq_no: 1,
        primary_term: 3,
    };
    for restarted in [false, true] {
        if restarted {
            copy.restart();
        }
        assert_eq!(copy.copies().position(INDEX, partition).unwrap(), expected);
        let stored = copy
            .engine()
            .get_with(INDEX, id, Some(&WHOLE_DOCUMENT))
            .unwrap();
        assert_eq!(stored, Some(order(id, 1)));
    }
    let beyond = copy.copies().position(INDEX, PARTITIONS).unwrap_err();
    assert_eq!(beyond.code(), ErrorCode::CONFIG_INVALID);
}

#[test]
fn a_failed_log_confirms_nothing_and_stops_its_partition_alone() {
    let mut primary = Copy::new("assigned-failed-primary", Storage::Memory);
    let mut replica = Copy::new("assigned-failed-replica", Storage::Memory);
    let id = "order-1";
    let partition = partition_of(id);
    let other = (0..20)
        .map(|number| format!("order-{number}"))
        .find(|other| partition_of(other) != partition)
        .expect("another partition holds an order");
    let insert = |id: &str| PrimaryWrite::Insert {
        document_id: id.to_string(),
        document: order(id, 1),
    };
    let limits = PrimaryLimits {
        records_previous_documents: false,
        max_entry_bytes: 1 << 20,
    };
    let sent = entry(id, 1, 2, Some(encoded(&order(id, 1))));
    let blocked = [&primary, &replica].map(|copy| {
        let logs = copy.root.path().join(INDEX).join("wal");
        std::fs::create_dir_all(&logs).expect("the log folder is created");
        let blocked = logs.join(partition.to_string());
        std::fs::write(&blocked, b"").expect("the log's path is blocked");
        blocked
    });

    let run = primary
        .copies()
        .write(INDEX, partition, 2, vec![insert(id)], limits)
        .expect("the failed run answers");
    assert!(run.failure.is_some());
    assert!(run.outcomes.iter().all(Result::is_err));
    assert_eq!(primary.engine().get(INDEX, id).unwrap(), None);
    let applied = replica
        .copies()
        .append(INDEX, partition, std::slice::from_ref(&sent))
        .expect("the failed run answers");
    assert_eq!(applied.applied, 0);
    assert!(applied.failure.is_some());
    assert!(follows(
        &primary,
        &replica,
        partition_of(&other),
        2,
        insert(&other)
    ));

    for path in &blocked {
        std::fs::remove_file(path).expect("the log's path is freed");
    }
    let refused = primary
        .copies()
        .write(INDEX, partition, 2, vec![insert(id)], limits);
    assert!(
        refused.is_err(),
        "a failed copy took a write before its reload"
    );
    let applied = replica
        .copies()
        .append(INDEX, partition, &[sent])
        .expect("the failed copy answers");
    assert_eq!(applied.applied, 0);

    primary.copies().reload_partition(INDEX, partition).unwrap();
    replica.copies().empty_partition(INDEX, partition).unwrap();
    assert_eq!(replica.engine().get(INDEX, id).unwrap(), None);
    assert!(follows(&primary, &replica, partition, 3, insert(id)));
    primary.restart();
    replica.restart();
    for copy in [&primary, &replica] {
        for stored in [id, other.as_str()] {
            let found = copy
                .engine()
                .get_with(INDEX, stored, Some(&WHOLE_DOCUMENT))
                .unwrap();
            assert_eq!(found, Some(order(stored, 1)));
        }
    }
}

#[test]
fn an_emptied_or_advanced_partition_numbers_from_its_new_position_after_a_restart() {
    let mut copy = Copy::new("assigned-emptied", Storage::Disk);
    let id = "order-7";
    let partition = partition_of(id);
    let bytes = encoded(&order(id, 9));
    let run: Vec<ReplicatedEntry> = (1..=9)
        .map(|seq_no| entry(id, seq_no, 2, Some(bytes.clone())))
        .collect();
    let applied = copy.copies().append(INDEX, partition, &run).unwrap();
    assert_eq!((applied.applied, applied.failure), (9, None));

    copy.copies().empty_partition(INDEX, partition).unwrap();
    copy.restart();
    assert_eq!(copy.engine().get(INDEX, id).unwrap(), None);
    assert_eq!(
        copy.copies().position(INDEX, partition).unwrap(),
        CopyPosition::default()
    );
    let applied = copy
        .copies()
        .append(INDEX, partition, &[entry(id, 1, 6, Some(bytes.clone()))])
        .unwrap();
    assert_eq!((applied.applied, applied.failure), (1, None));

    let promoted = CopyPosition {
        seq_no: 40,
        primary_term: 8,
    };
    copy.copies().advance(INDEX, partition, promoted).unwrap();
    copy.restart();
    assert_eq!(copy.copies().position(INDEX, partition).unwrap(), promoted);
    let applied = copy
        .copies()
        .append(INDEX, partition, &[entry(id, 41, 8, Some(bytes.clone()))])
        .unwrap();
    assert_eq!((applied.applied, applied.failure), (1, None));
    copy.restart();

    let stored = copy.copies().document(INDEX, id).unwrap();
    assert_eq!(
        stored.map(Value::Object),
        Some(decode_msgpack(&bytes).unwrap())
    );
    assert_eq!(
        copy.copies().write_record(INDEX, partition, id).unwrap(),
        Some(WriteRecord {
            seq_no: 41,
            primary_term: 8,
        })
    );
}

fn small_segment_engine(root: &Path) -> Narsil {
    Narsil::open(NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            segment_max_bytes: Some(TORN_SEGMENT_MAX_BYTES),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    })
    .expect("the engine opens")
}

fn padded_order(id: &str, round: u64) -> Map {
    let mut document = order(id, round);
    document.insert(
        "item",
        Value::from(format!("{round} {}", "a".repeat(TORN_ITEM_CHARACTERS))),
    );
    document
}

#[test]
fn a_reload_after_a_torn_append_keeps_every_acknowledged_write_across_a_restart() {
    let root = ScratchDirectory::new("assigned-torn");
    let mut engine = small_segment_engine(root.path());
    PartitionCopies::new(&engine)
        .create_index(INDEX, index_config(Storage::Memory), UUID, PARTITIONS)
        .expect("the copy is created");
    let partition = partition_of("order-1");
    let candidates = (0..200).map(|number| format!("order-{number}"));
    let ids: Vec<String> = candidates
        .clone()
        .filter(|id| partition_of(id) == partition)
        .take(3)
        .collect();
    let other = candidates
        .clone()
        .find(|id| partition_of(id) != partition)
        .expect("another partition holds an order");
    let documents: Vec<Map> = (1..)
        .zip(&ids)
        .map(|(round, id)| padded_order(id, round))
        .collect();
    let entries: Vec<ReplicatedEntry> = (1..)
        .zip(ids.iter().zip(&documents))
        .map(|(seq_no, (id, document))| entry(id, seq_no, 2, Some(encoded(document))))
        .collect();
    let logs = root
        .path()
        .join(INDEX)
        .join("wal")
        .join(partition.to_string());
    let segment = logs.join(format!("{:016}", 1));
    let mut lengths = Vec::new();
    for sent in &entries[..2] {
        let applied = PartitionCopies::new(&engine)
            .append(INDEX, partition, std::slice::from_ref(sent))
            .expect("the entry applies");
        assert_eq!((applied.applied, applied.failure), (1, None));
        lengths.push(
            std::fs::metadata(&segment)
                .expect("the segment exists")
                .len(),
        );
    }
    assert!(lengths[1] > lengths[0], "both entries share one segment");
    let written = std::fs::read(&segment).expect("the segment is read");
    let frame = &written[lengths[0] as usize..lengths[1] as usize];
    OpenOptions::new()
        .append(true)
        .open(&segment)
        .and_then(|mut file| file.write_all(&frame[..frame.len() / 2]))
        .expect("a torn frame follows the durable records");
    let blocked = logs.join(format!("{:016}", 3));
    std::fs::create_dir(&blocked).expect("the next segment's path is blocked");

    let failed = PartitionCopies::new(&engine)
        .append(INDEX, partition, &entries[2..])
        .expect("the failed run answers");
    assert_eq!(failed.applied, 0);
    assert!(failed.failure.is_some());
    std::fs::remove_dir(&blocked).expect("the next segment's path is freed");
    let elsewhere = entry(&other, 1, 2, Some(encoded(&order(&other, 1))));
    let applied = PartitionCopies::new(&engine)
        .append(INDEX, partition_of(&other), &[elsewhere])
        .expect("another partition takes its entry");
    assert_eq!((applied.applied, applied.failure), (1, None));

    PartitionCopies::new(&engine)
        .reload_partition(INDEX, partition)
        .expect("the partition reloads");
    assert_eq!(
        PartitionCopies::new(&engine)
            .position(INDEX, partition)
            .unwrap(),
        CopyPosition {
            seq_no: 2,
            primary_term: 2,
        }
    );
    let applied = PartitionCopies::new(&engine)
        .append(INDEX, partition, &entries[2..])
        .expect("the reloaded partition takes the entry");
    assert_eq!((applied.applied, applied.failure), (1, None));

    engine.shutdown().expect("the engine shuts down");
    drop(engine);
    engine = small_segment_engine(root.path());
    assert_eq!(
        PartitionCopies::new(&engine)
            .position(INDEX, partition)
            .unwrap(),
        CopyPosition {
            seq_no: 3,
            primary_term: 2,
        }
    );
    for (id, document) in ids.iter().zip(&documents) {
        let stored = engine
            .get_with(INDEX, id, Some(&WHOLE_DOCUMENT))
            .expect("the read answers");
        assert_eq!(stored.as_ref(), Some(document));
    }
    let stored = engine
        .get_with(INDEX, &other, Some(&WHOLE_DOCUMENT))
        .expect("the read answers");
    assert_eq!(stored, Some(order(&other, 1)));
}
