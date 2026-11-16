#![cfg(any(target_os = "linux", target_os = "macos", windows))]

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{
    ErrorCode, IndexConfig, Map, MemoryConfig, Narsil, NarsilConfig, QueryParams, Token, Tokenizer,
    TokenizerSetting, Value,
};

const INDEX: &str = "manuals";
const TOKENIZER: &str = "spaced";
const HOLDING_QUERY: &str = "hold";
const DISTINCT_TERMS: usize = 150_000;
const HEADROOM_BYTES: f64 = 256.0 * 1024.0 * 1024.0;
const RESUME_HEADROOM_BYTES: f64 = HEADROOM_BYTES / 2.0;
const ROOM_LEFT_BYTES: u64 = 12 * 1024 * 1024;
const HELD_SEARCH_START: Duration = Duration::from_secs(30);
const HELD_SEARCH_RELEASE: Duration = Duration::from_secs(60);

struct HoldingTokenizer {
    entered: Mutex<Sender<()>>,
    release: Mutex<Receiver<()>>,
}

impl Tokenizer for HoldingTokenizer {
    fn tokenize(&self, text: &str) -> Vec<Token> {
        if text == HOLDING_QUERY {
            if let Ok(entered) = self.entered.lock() {
                let _ = entered.send(());
            }
            if let Ok(release) = self.release.lock() {
                let _ = release.recv_timeout(HELD_SEARCH_RELEASE);
            }
        }
        text.split_whitespace()
            .enumerate()
            .map(|(position, word)| Token {
                token: word.to_string(),
                position: position as u32,
            })
            .collect()
    }
}

struct Figures {
    process_bytes: f64,
    limit_bytes: f64,
}

fn titled(title: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title.to_string()));
    document
}

fn number_of(details: &Map, key: &str) -> f64 {
    details
        .get(key)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("the details hold no number at {key}: {details:?}"))
}

fn index_config(tokenizer: Option<TokenizerSetting>) -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    IndexConfig {
        schema: Value::Object(schema),
        tokenizer,
        ..IndexConfig::default()
    }
}

fn process_figures() -> Option<Figures> {
    let engine = Narsil::open(NarsilConfig {
        memory: Some(MemoryConfig {
            block_writes_above: Some(1e-12),
            resume_writes_below: Some(1e-13),
        }),
        ..NarsilConfig::default()
    })
    .expect("the engine opens");
    engine
        .create_index(INDEX, index_config(None))
        .expect("created");
    let refused = engine.insert(INDEX, titled("boiler"), Some("probe")).err();
    engine.shutdown().expect("stops");
    let details = refused?.details()?.clone();
    Some(Figures {
        process_bytes: number_of(&details, "processBytes"),
        limit_bytes: number_of(&details, "processLimitBytes"),
    })
}

fn distinct_text(terms: usize) -> String {
    (0..terms)
        .map(|serial| format!("part{serial:06}"))
        .collect::<Vec<String>>()
        .join(" ")
}

fn stored_title(engine: &Narsil, id: &str) -> Option<Value> {
    let stored = engine.get(INDEX, id).expect("read").expect("stored");
    stored.get("title").cloned()
}

#[test]
fn an_update_is_refused_while_a_search_holds_the_tail_that_its_removal_would_copy_past_the_block() {
    let Some(figures) = process_figures() else {
        eprintln!(
            "skipped: this system reports no process memory figures, so the engine bounds no write"
        );
        return;
    };
    let block = (figures.process_bytes + HEADROOM_BYTES) / figures.limit_bytes;
    let resume = (figures.process_bytes + RESUME_HEADROOM_BYTES) / figures.limit_bytes;
    let block_bytes = (block * figures.limit_bytes).floor() as u64;
    let engine = Narsil::open(NarsilConfig {
        memory: Some(MemoryConfig {
            block_writes_above: Some(block),
            resume_writes_below: Some(resume),
        }),
        ..NarsilConfig::default()
    })
    .expect("the engine opens");
    let (entered_sender, entered) = channel();
    let (release, release_receiver) = channel();
    engine
        .register_tokenizer(
            TOKENIZER,
            Arc::new(HoldingTokenizer {
                entered: Mutex::new(entered_sender),
                release: Mutex::new(release_receiver),
            }),
        )
        .expect("the tokenizer is registered");
    engine
        .create_index(
            INDEX,
            index_config(Some(TokenizerSetting::Named(TOKENIZER.to_string()))),
        )
        .expect("created");
    engine
        .insert(
            INDEX,
            titled(&distinct_text(DISTINCT_TERMS)),
            Some("catalogue"),
        )
        .expect("the catalogue fits under the block");
    engine
        .insert(INDEX, titled("valve"), Some("target"))
        .expect("a small insert fits");
    let used = process_figures()
        .expect("the figures are still reported")
        .process_bytes as u64;
    let ballast_bytes = block_bytes
        .checked_sub(used + ROOM_LEFT_BYTES)
        .expect("the catalogue leaves more room than the test keeps free");
    let ballast = std::hint::black_box(vec![1u8; ballast_bytes as usize]);

    std::thread::scope(|scope| {
        let search = scope.spawn(|| {
            engine.query(
                INDEX,
                &QueryParams {
                    term: Some(HOLDING_QUERY.to_string()),
                    ..QueryParams::default()
                },
            )
        });
        entered
            .recv_timeout(HELD_SEARCH_START)
            .expect("the search reaches its tokenizer");
        let updated = engine.update(INDEX, "target", titled("gasket"));
        let _ = release.send(());
        let refused = updated.expect_err("copying the held tail would pass the block");
        assert_eq!(
            refused.code(),
            ErrorCode::MEMORY_WRITE_BLOCKED,
            "{refused:?}"
        );
        let details = refused.details().expect("the refusal carries details");
        assert_eq!(
            details.get("reason"),
            Some(&Value::from("write_would_fill_memory"))
        );
        assert!(
            number_of(details, "documentBytes") + number_of(details, "processBytes")
                < number_of(details, "blockBytes"),
            "the document alone fits, so only the copy of the tail can pass the block: {details:?}"
        );
        assert_eq!(stored_title(&engine, "target"), Some(Value::from("valve")));
        search
            .join()
            .expect("the search thread finishes")
            .expect("the held search answers");
    });
    engine.shutdown().expect("stops");
    drop(ballast);
}
