#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ClassName {
    Digit,
    Word,
    Space,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SetItem {
    Member(u32),
    Range(u32, u32),
    Class(ClassName),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Node {
    Literal(u32),
    Any,
    Class(ClassName),
    Set {
        negated: bool,
        items: Vec<SetItem>,
    },
    Assert(u16),
    Sequence(Vec<Node>),
    Choice(Vec<Node>),
    Repeat {
        body: Box<Node>,
        min: u32,
        max: Option<u32>,
    },
    NumberRange(Box<Node>),
}

pub(crate) const START_MASK: u16 = 0b000_000_111;
pub(crate) const END_MASK: u16 = 0b001_001_001;
pub(crate) const WORD_EDGE_MASK: u16 = 0b010_101_010;

pub(crate) struct ParseFailure {
    pub(crate) reason: String,
    pub(crate) at: usize,
}

pub(crate) type Parsed<T> = Result<T, ParseFailure>;

pub(crate) fn failure<T>(reason: impl Into<String>, at: usize) -> Parsed<T> {
    Err(ParseFailure {
        reason: reason.into(),
        at,
    })
}

pub(crate) const TRAILING_ESCAPE: &str = r#"ends in a "\" with no code point after it"#;

pub(crate) fn quoted(text: &str) -> String {
    format!("\"{text}\"")
}

pub(crate) fn code_points_of(text: &str) -> Vec<u32> {
    text.chars().map(|character| character as u32).collect()
}

pub(crate) fn text_of(code_point: u32) -> String {
    char::from_u32(code_point).map_or_else(String::new, String::from)
}
