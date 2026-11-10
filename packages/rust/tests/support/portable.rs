use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use narsil::{
    DurabilityConfig, DurabilityTier, FilesystemPersistence, IndexConfig, Map, Narsil,
    NarsilConfig, Value,
};

pub const DIMENSION: usize = 8;
const WORDS: [&str; 8] = [
    "harbour", "lantern", "meadow", "copper", "orchard", "glacier", "willow", "ember",
];

#[derive(Clone, Copy, Debug)]
pub enum Tier {
    Memory,
    Log,
    Snapshot,
}

impl Tier {
    pub fn open(self, root: &Path) -> Narsil {
        let config = match self {
            Tier::Memory => return Narsil::new(),
            Tier::Log => NarsilConfig {
                durability: Some(DurabilityConfig {
                    directory: Some(root.to_path_buf()),
                    ..DurabilityConfig::default()
                }),
                ..NarsilConfig::default()
            },
            Tier::Snapshot => NarsilConfig {
                durability: Some(DurabilityConfig {
                    tier: Some(DurabilityTier::Snapshot),
                    ..DurabilityConfig::default()
                }),
                persistence: Some(Arc::new(
                    FilesystemPersistence::new(root).expect("the persistence directory opens"),
                )),
                ..NarsilConfig::default()
            },
        };
        Narsil::open(config).expect("the engine opens")
    }

    pub fn durable(self) -> bool {
        !matches!(self, Tier::Memory)
    }
}

pub fn index_config() -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    schema.insert("tags", Value::String("string[]".into()));
    schema.insert("price", Value::String("number".into()));
    schema.insert("stocked", Value::String("boolean".into()));
    schema.insert("embedding", Value::String(format!("vector[{DIMENSION}]")));
    IndexConfig {
        schema: Value::Object(schema),
        ..IndexConfig::default()
    }
}

fn embedding_of(seed: u64) -> Vec<f32> {
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(7);
    (0..DIMENSION)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            ((state % 2_000_001) as f64 / 1_000_000.0 - 1.0) as f32
        })
        .collect()
}

pub fn title_of(seed: u64) -> String {
    let first = WORDS[(seed % WORDS.len() as u64) as usize];
    let second = WORDS[((seed / 3) % WORDS.len() as u64) as usize];
    format!("{first} {second} item {seed}")
}

pub fn document_of(prefix: &str, seed: u64) -> (String, Map) {
    let id = format!("{prefix}-{seed:05}");
    let mut document = Map::new();
    document.insert("title", Value::String(title_of(seed)));
    let tags = vec![
        Value::String(WORDS[(seed % 5) as usize].to_string()),
        Value::String(WORDS[(seed % 7) as usize].to_string()),
    ];
    document.insert("tags", Value::Array(tags));
    document.insert("price", Value::Number(seed as f64 * 1.25 + 0.1));
    document.insert("stocked", Value::Bool(seed % 3 == 0));
    if seed % 4 != 1 {
        let values = embedding_of(seed)
            .into_iter()
            .map(|value| Value::Number(f64::from(value)))
            .collect();
        document.insert("embedding", Value::Array(values));
    }
    (id, document)
}

pub fn documents(prefix: &str, seeds: std::ops::Range<u64>) -> BTreeMap<String, Map> {
    seeds.map(|seed| document_of(prefix, seed)).collect()
}

pub fn with_id(id: &str, document: &Map) -> Map {
    let mut held = document.clone();
    held.insert("id", Value::String(id.to_string()));
    held
}

pub fn fill(narsil: &Narsil, index: &str, documents: &BTreeMap<String, Map>) {
    let batch = documents
        .iter()
        .map(|(id, document)| with_id(id, document))
        .collect();
    let result = narsil.insert_batch(index, batch).expect("the batch runs");
    assert!(
        result.failed.is_empty(),
        "the batch refused {:?}",
        result.failed
    );
}

pub fn held_documents(narsil: &Narsil, index: &str, ids: &[String]) -> BTreeMap<String, Map> {
    narsil
        .get_multiple(index, ids)
        .expect("the documents read")
        .into_iter()
        .map(|(id, mut document)| {
            document.remove("id");
            (id, document)
        })
        .collect()
}

pub fn snapshot_of(narsil: &Narsil, index: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    narsil
        .snapshot(index, &mut bytes)
        .expect("the snapshot writes");
    bytes
}

pub fn export_of(narsil: &Narsil, index: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    narsil
        .export_documents(index, &mut bytes)
        .expect("the export writes");
    bytes
}

pub fn source_engine(documents: &BTreeMap<String, Map>) -> Narsil {
    let narsil = Narsil::new();
    narsil
        .create_index("source", index_config())
        .expect("the source index is created");
    fill(&narsil, "source", documents);
    narsil
}

pub fn every_id<'a>(sets: impl IntoIterator<Item = &'a BTreeMap<String, Map>>) -> Vec<String> {
    let mut ids: Vec<String> = sets
        .into_iter()
        .flat_map(|set| set.keys().cloned())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}
