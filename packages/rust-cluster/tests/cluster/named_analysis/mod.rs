#![allow(dead_code)]

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use narsil::{
    AdapterError, EmbeddingAdapter, EmbeddingPurpose, Narsil, StopWords, Token, Tokenizer,
};
use narsil_cluster::node::ClusterNodeConfig;

use crate::data_node::engine_config;

pub const STOP_WORDS_NAME: &str = "fleet-words";
pub const TOKENIZER_NAME: &str = "pipe-separated";
pub const ADAPTER_NAME: &str = "letter-shape";
pub const SHAPE_DIMENSIONS: usize = 3;
pub const FLEET_STOP_WORDS: [&str; 2] = ["zebra", "garage"];

pub fn letter_shape(text: &str) -> Vec<f32> {
    let lower = text.to_lowercase();
    let count = |wanted: char| lower.chars().filter(|letter| *letter == wanted).count() as f32;
    vec![count('a'), count('o'), lower.chars().count() as f32]
}

struct LetterShape;

impl EmbeddingAdapter for LetterShape {
    fn dimensions(&self) -> usize {
        SHAPE_DIMENSIONS
    }

    fn embed(&self, input: &str, _purpose: EmbeddingPurpose) -> Result<Vec<f32>, AdapterError> {
        Ok(letter_shape(input))
    }
}

struct PipeSeparated;

impl Tokenizer for PipeSeparated {
    fn tokenize(&self, text: &str) -> Vec<Token> {
        text.split('|')
            .map(|part| part.trim().to_lowercase())
            .filter(|part| !part.is_empty())
            .enumerate()
            .map(|(position, token)| Token {
                token,
                position: position as u32,
            })
            .collect()
    }
}

fn fleet_stop_words() -> StopWords {
    StopWords::Set(
        FLEET_STOP_WORDS
            .iter()
            .map(|word| word.to_string())
            .collect::<HashSet<_>>(),
    )
}

pub fn with_named_analysis(settings: &mut ClusterNodeConfig) {
    with_named_analysis_except_stop_words(settings);
    if let Some(data) = settings.data.as_mut() {
        data.stop_words
            .insert(STOP_WORDS_NAME.to_string(), fleet_stop_words());
    }
}

pub fn with_named_analysis_except_stop_words(settings: &mut ClusterNodeConfig) {
    let Some(data) = settings.data.as_mut() else {
        return;
    };
    data.tokenizers
        .insert(TOKENIZER_NAME.to_string(), Arc::new(PipeSeparated));
    data.embedding_adapters
        .insert(ADAPTER_NAME.to_string(), Arc::new(LetterShape));
}

pub fn open_with_named_analysis(directory: &Path) -> Narsil {
    Narsil::open_with(engine_config(directory), |engine| {
        engine.register_stop_words(STOP_WORDS_NAME, fleet_stop_words())?;
        engine.register_tokenizer(TOKENIZER_NAME, Arc::new(PipeSeparated))?;
        engine.register_embedding_adapter(ADAPTER_NAME, Arc::new(LetterShape))
    })
    .expect("the engine opens with the named analysis")
}
