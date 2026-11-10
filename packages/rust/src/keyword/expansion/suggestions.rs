use super::{ExpansionSources, units};
use crate::error::Result;
use crate::ffi;
use crate::keyword::constants::{
    MAX_ROOM_ATTEMPTS, SUGGESTION_SPELLINGS_PER_TERM, SUGGESTION_TERM_START_CAPACITY,
};
use crate::keyword::workspace::{core_refused, with_workspace};

const WORDS: usize = ffi::NARSIL_SUGGESTION_WORDS;

pub(crate) struct Suggestion {
    pub(crate) token: String,
    pub(crate) document_frequency: u32,
    pub(crate) spellings: Vec<(String, f64)>,
}

struct SuggestionOutput {
    terms: Vec<u32>,
    starts: Vec<u32>,
    spellings: Vec<u32>,
    occurrences: Vec<f64>,
}

impl SuggestionOutput {
    fn new(terms: usize, spellings: usize) -> SuggestionOutput {
        SuggestionOutput {
            terms: vec![0; terms * WORDS],
            starts: vec![0; terms + 1],
            spellings: vec![0; spellings * WORDS],
            occurrences: vec![0.0; spellings],
        }
    }

    fn raw(&mut self) -> ffi::narsil_suggestion_output {
        ffi::narsil_suggestion_output {
            terms: self.terms.as_mut_ptr(),
            term_words: self.terms.len(),
            starts: self.starts.as_mut_ptr(),
            start_capacity: self.starts.len(),
            spellings: self.spellings.as_mut_ptr(),
            spelling_words: self.spellings.len(),
            occurrences: self.occurrences.as_mut_ptr(),
            occurrence_capacity: self.occurrences.len(),
        }
    }
}

impl ExpansionSources<'_> {
    fn spelling_text(&self, words: &[u32]) -> Result<String> {
        match words[1] as usize {
            ffi::NARSIL_SUGGESTION_TOKEN => self.token(words[0], words[2]),
            _ => self.surface(words[0], words[2]),
        }
    }

    fn read_suggestions(&self, output: &SuggestionOutput, count: usize) -> Result<Vec<Suggestion>> {
        let mut suggestions = Vec::with_capacity(count);
        for at in 0..count {
            let term = &output.terms[at * WORDS..(at + 1) * WORDS];
            let from = output.starts[at] as usize;
            let to = output.starts[at + 1] as usize;
            let mut spellings = Vec::with_capacity(to.saturating_sub(from));
            for next in from..to {
                let words = &output.spellings[next * WORDS..(next + 1) * WORDS];
                spellings.push((self.spelling_text(words)?, output.occurrences[next]));
            }
            suggestions.push(Suggestion {
                token: self.token(term[0], term[1])?,
                document_frequency: term[2],
                spellings,
            });
        }
        Ok(suggestions)
    }

    pub(crate) fn suggest(
        &self,
        typed: &str,
        stemmed: &str,
        limit: u32,
    ) -> Result<Vec<Suggestion>> {
        let typed = units(typed);
        let stemmed = units(stemmed);
        let (segments, segment_count) = self.segments();
        let request = ffi::narsil_suggestion_request {
            segments,
            segment_count,
            typed: typed.as_ptr(),
            typed_length: typed.len(),
            stemmed: stemmed.as_ptr(),
            stemmed_length: stemmed.len(),
            limit,
        };
        let mut terms = (limit as usize).clamp(1, SUGGESTION_TERM_START_CAPACITY);
        for _ in 0..MAX_ROOM_ATTEMPTS {
            let mut output = SuggestionOutput::new(terms, terms * SUGGESTION_SPELLINGS_PER_TERM);
            let raw = output.raw();
            let mut count = 0u32;
            let status = with_workspace(|workspace| {
                Ok(unsafe { ffi::narsil_suggest_terms(workspace, &request, &raw, &mut count) })
            })?;
            match status {
                ffi::NARSIL_OK => return self.read_suggestions(&output, count as usize),
                ffi::NARSIL_NEEDS_ROOM => terms *= 2,
                status => return Err(core_refused("a term suggestion", status)),
            }
        }
        Err(core_refused("a term suggestion", ffi::NARSIL_NEEDS_ROOM))
    }
}
