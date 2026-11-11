use super::ast::{
    ClassName, END_MASK, Node, Parsed, START_MASK, TRAILING_ESCAPE, WORD_EDGE_MASK, failure,
    quoted, text_of,
};
use crate::pattern::constants::{MAX_PATTERN_GROUP_DEPTH, MAX_PATTERN_REPEAT_COUNT};

pub(super) const BACKSLASH: u32 = 0x5c;
const DOT: u32 = 0x2e;
const BAR: u32 = 0x7c;
const STAR: u32 = 0x2a;
const PLUS: u32 = 0x2b;
const QUESTION: u32 = 0x3f;
const OPEN_BRACE: u32 = 0x7b;
const CLOSE_BRACE: u32 = 0x7d;
const OPEN_PAREN: u32 = 0x28;
const CLOSE_PAREN: u32 = 0x29;
pub(super) const OPEN_BRACKET: u32 = 0x5b;
pub(super) const CLOSE_BRACKET: u32 = 0x5d;
pub(super) const CARET: u32 = 0x5e;
const DOLLAR: u32 = 0x24;
const LESS: u32 = 0x3c;
pub(super) const GREATER: u32 = 0x3e;
pub(super) const HYPHEN: u32 = 0x2d;
const COMMA: u32 = 0x2c;
const ZERO: u32 = 0x30;
const NINE: u32 = 0x39;
const WORD_EDGE_ESCAPE: u32 = 0x62;
const LOWER_P: u32 = 0x70;
const UPPER_P: u32 = 0x50;

const RESERVED: [u32; 16] = [
    BACKSLASH,
    DOT,
    BAR,
    STAR,
    PLUS,
    QUESTION,
    OPEN_BRACE,
    CLOSE_BRACE,
    OPEN_PAREN,
    CLOSE_PAREN,
    OPEN_BRACKET,
    CLOSE_BRACKET,
    CARET,
    DOLLAR,
    LESS,
    GREATER,
];

const NO_COUNT: &str = r#"holds a "{" that doesn't open a count such as {2}, {2,}, or {2,5}. Write "\{" to match the brace itself"#;

pub(super) fn class_escape(code_point: u32) -> Option<ClassName> {
    match code_point {
        0x64 => Some(ClassName::Digit),
        0x77 => Some(ClassName::Word),
        0x73 => Some(ClassName::Space),
        _ => None,
    }
}

pub(super) fn is_ascii_punctuation(code_point: u32) -> bool {
    (0x21..=0x2f).contains(&code_point)
        || (0x3a..=0x40).contains(&code_point)
        || (0x5b..=0x60).contains(&code_point)
        || (0x7b..=0x7e).contains(&code_point)
}

pub(super) fn is_digit(code_point: Option<u32>) -> bool {
    code_point.is_some_and(|code_point| (ZERO..=NINE).contains(&code_point))
}

pub(super) fn unknown_escape(code_point: u32) -> String {
    let shown = quoted(&format!("\\{}", text_of(code_point)));
    if is_digit(Some(code_point)) {
        return format!("holds the back-reference {shown}, which the grammar leaves out");
    }
    if code_point == LOWER_P || code_point == UPPER_P {
        return format!("holds the Unicode property class {shown}, which the grammar leaves out");
    }
    format!(
        r#"holds {shown}. A "\" can come only before an ASCII punctuation mark, "d", "w", "s", or "b""#
    )
}

fn reserved_here(code_point: u32) -> String {
    let shown = text_of(code_point);
    if code_point == STAR || code_point == PLUS || code_point == QUESTION {
        return format!(
            "holds the repeat {} with nothing before it to repeat",
            quoted(&shown)
        );
    }
    format!(
        "holds {}, which has a meaning of its own in the grammar. Write {} to match the code point itself",
        quoted(&shown),
        quoted(&format!("\\{shown}"))
    )
}

fn is_repeat(code_point: Option<u32>) -> bool {
    matches!(code_point, Some(STAR | PLUS | QUESTION | OPEN_BRACE))
}

pub(crate) struct RegexReader<'a> {
    pub(super) code_points: &'a [u32],
    pub(super) at: usize,
    depth: usize,
}

impl<'a> RegexReader<'a> {
    pub(crate) fn parse(code_points: &'a [u32]) -> Parsed<Node> {
        let mut reader = RegexReader {
            code_points,
            at: 0,
            depth: 0,
        };
        let pattern = reader.parse_pattern()?;
        if reader.at < code_points.len() {
            return failure("closes a group that it never opened", reader.at);
        }
        Ok(pattern)
    }

    pub(super) fn peek(&self, offset: usize) -> Option<u32> {
        self.code_points.get(self.at + offset).copied()
    }

    pub(super) fn take(&mut self) -> Option<u32> {
        let code_point = self.code_points.get(self.at).copied();
        self.at += 1;
        code_point
    }

    fn parse_pattern(&mut self) -> Parsed<Node> {
        let mut branches = vec![self.parse_branch()?];
        while self.peek(0) == Some(BAR) {
            self.at += 1;
            branches.push(self.parse_branch()?);
        }
        if branches.len() == 1 {
            return Ok(branches.remove(0));
        }
        Ok(Node::Choice(branches))
    }

    fn parse_branch(&mut self) -> Parsed<Node> {
        let mut items = Vec::new();
        while let Some(next) = self.peek(0) {
            if next == BAR || next == CLOSE_PAREN {
                break;
            }
            items.push(self.parse_piece()?);
        }
        if items.len() == 1 {
            return Ok(items.remove(0));
        }
        Ok(Node::Sequence(items))
    }

    fn parse_piece(&mut self) -> Parsed<Node> {
        let atom = self.parse_atom()?;
        let (piece, repeated) = self.parse_repeat(atom)?;
        let next = self.peek(0);
        if repeated && is_repeat(next) {
            return failure(
                format!(
                    "holds a second repeat {} after one atom. The grammar allows one repeat for each atom, so it has no lazy or possessive repeats",
                    quoted(&text_of(next.unwrap_or(0)))
                ),
                self.at,
            );
        }
        Ok(piece)
    }

    fn parse_atom(&mut self) -> Parsed<Node> {
        let start = self.at;
        let code_point = self.take().unwrap_or(0);
        match code_point {
            BACKSLASH => self.parse_escape(start),
            DOT => Ok(Node::Any),
            CARET => Ok(Node::Assert(START_MASK)),
            DOLLAR => Ok(Node::Assert(END_MASK)),
            OPEN_BRACKET => self.parse_set(start),
            OPEN_PAREN => self.parse_group(start),
            LESS => self.parse_number_range(start),
            _ if RESERVED.contains(&code_point) => failure(reserved_here(code_point), start),
            _ => Ok(Node::Literal(code_point)),
        }
    }

    fn parse_escape(&mut self, start: usize) -> Parsed<Node> {
        let Some(escaped) = self.take() else {
            return failure(TRAILING_ESCAPE, start);
        };
        if let Some(name) = class_escape(escaped) {
            return Ok(Node::Class(name));
        }
        if escaped == WORD_EDGE_ESCAPE {
            return Ok(Node::Assert(WORD_EDGE_MASK));
        }
        if is_ascii_punctuation(escaped) {
            return Ok(Node::Literal(escaped));
        }
        failure(unknown_escape(escaped), start)
    }

    fn parse_group(&mut self, start: usize) -> Parsed<Node> {
        if self.peek(0) == Some(QUESTION) {
            return failure(
                r#"holds "(?", which opens a lookaround, an inline flag, or a non-capturing group. The grammar leaves out all three"#,
                start,
            );
        }
        self.depth += 1;
        if self.depth > MAX_PATTERN_GROUP_DEPTH {
            return failure(
                format!("nests its groups more than {MAX_PATTERN_GROUP_DEPTH} deep"),
                start,
            );
        }
        let body = self.parse_pattern()?;
        if self.peek(0) != Some(CLOSE_PAREN) {
            return failure("opens a group that it never closes", start);
        }
        self.at += 1;
        self.depth -= 1;
        Ok(body)
    }

    fn parse_repeat(&mut self, atom: Node) -> Parsed<(Node, bool)> {
        let code_point = self.peek(0);
        if let Some(mark @ (STAR | PLUS | QUESTION)) = code_point {
            self.at += 1;
            let min = u32::from(mark == PLUS);
            let max = (mark == QUESTION).then_some(1);
            let body = Box::new(atom);
            return Ok((Node::Repeat { body, min, max }, true));
        }
        if code_point != Some(OPEN_BRACE) {
            return Ok((atom, false));
        }
        let start = self.at;
        self.at += 1;
        let min = self.read_count(start)?;
        let mut max = Some(min);
        if self.peek(0) == Some(COMMA) {
            self.at += 1;
            max = if is_digit(self.peek(0)) {
                Some(self.read_count(start)?)
            } else {
                None
            };
        }
        if self.peek(0) != Some(CLOSE_BRACE) {
            return failure(NO_COUNT, start);
        }
        self.at += 1;
        if let Some(max) = max.filter(|max| min > *max) {
            return failure(
                format!(
                    "holds the count {{{min},{max}}}, whose lower count is above its upper count"
                ),
                start,
            );
        }
        let body = Box::new(atom);
        Ok((Node::Repeat { body, min, max }, true))
    }

    fn read_count(&mut self, start: usize) -> Parsed<u32> {
        if !is_digit(self.peek(0)) {
            return failure(NO_COUNT, start);
        }
        let mut count: u32 = 0;
        while let Some(digit) = self.peek(0).filter(|digit| is_digit(Some(*digit))) {
            count = (count * 10 + digit - ZERO).min(MAX_PATTERN_REPEAT_COUNT + 1);
            self.at += 1;
        }
        if count > MAX_PATTERN_REPEAT_COUNT {
            return failure(
                format!("holds a count above the limit of {MAX_PATTERN_REPEAT_COUNT}"),
                start,
            );
        }
        Ok(count)
    }
}
