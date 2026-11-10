pub(crate) mod constants;
pub(crate) mod expression;
pub(crate) mod meter;
pub(crate) mod native;
pub(crate) mod text;
pub(crate) mod typo_text;

pub(crate) use self::meter::{SearchLimits, SearchStop, WorkMeter};
pub(crate) use self::native::{PatternIndexes, PatternOperator, PatternTest, PatternTolerance};
