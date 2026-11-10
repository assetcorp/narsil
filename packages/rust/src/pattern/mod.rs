pub(crate) mod automaton;
pub(crate) mod constants;
mod dfa;
pub(crate) mod expression;
pub(crate) mod fold;
mod fold_table;
pub(crate) mod index;
mod literal;
pub(crate) mod matching;
pub(crate) mod meter;
pub(crate) mod prepared;
mod shortlist;
mod simulation;
pub(crate) mod text;
pub(crate) mod typo_text;

pub(crate) use self::index::{GrowingPatternIndex, PatternIndexRef};
pub(crate) use self::matching::{PatternScratch, PatternTarget, TextValues, match_pattern};
pub(crate) use self::meter::WorkMeter;
pub(crate) use self::prepared::{
    PatternOperator, PatternTolerance, PreparedPattern, prepare_pattern,
};
