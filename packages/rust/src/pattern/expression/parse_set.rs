use super::ast::{
    Node, Parsed, SetItem, TRAILING_ESCAPE, code_points_of, failure, quoted, text_of,
};
use super::number_range::{digits_value, number_range};
use super::parse_regex::{
    BACKSLASH, CARET, CLOSE_BRACKET, GREATER, HYPHEN, OPEN_BRACKET, RegexReader, class_escape,
    is_ascii_punctuation, is_digit, unknown_escape,
};
use crate::pattern::constants::MAX_NUMBER_RANGE_DIGITS;

const RANGE_ENDS_IN_CLASS: &str = "holds a set range whose high end is a class, while both ends of a set range must be code points";
const SET_NEVER_CLOSES: &str = "opens a set that it never closes";
const NEGATED_EMPTY_SET: &str = r#"holds the set "[^]", which has no member, because a "^" after "[" always negates the set. Write "\^" to match a caret, "." to match any code point, or "\]" to match "]" inside a set"#;

enum SetMember {
    CodePoint(u32),
    Item(SetItem),
}

impl RegexReader<'_> {
    pub(super) fn parse_set(&mut self, start: usize) -> Parsed<Node> {
        let negated = self.peek(0) == Some(CARET);
        if negated {
            self.at += 1;
        }
        let mut items = Vec::new();
        loop {
            match self.peek(0) {
                None => return failure(SET_NEVER_CLOSES, start),
                Some(CLOSE_BRACKET) => break,
                Some(_) => items.push(self.parse_set_item()?),
            }
        }
        self.at += 1;
        if items.is_empty() {
            let reason = if negated {
                NEGATED_EMPTY_SET
            } else {
                "holds an empty set"
            };
            return failure(reason, start);
        }
        Ok(Node::Set { negated, items })
    }

    fn parse_set_item(&mut self) -> Parsed<SetItem> {
        let start = self.at;
        let low = match self.parse_set_member(true)? {
            SetMember::Item(item) => return Ok(item),
            SetMember::CodePoint(low) => low,
        };
        if self.peek(0) != Some(HYPHEN) || self.peek(1) == Some(CLOSE_BRACKET) {
            return Ok(SetItem::Member(low));
        }
        self.at += 1;
        let high = match self.parse_set_member(false)? {
            SetMember::Item(_) => return failure(RANGE_ENDS_IN_CLASS, start),
            SetMember::CodePoint(high) => high,
        };
        if low > high {
            let shown = format!("{}-{}", text_of(low), text_of(high));
            return failure(
                format!(
                    "holds the set range {}, whose low end is above its high end",
                    quoted(&shown)
                ),
                start,
            );
        }
        Ok(SetItem::Range(low, high))
    }

    fn parse_set_member(&mut self, class_allowed: bool) -> Parsed<SetMember> {
        let start = self.at;
        let Some(code_point) = self.take() else {
            return failure(SET_NEVER_CLOSES, start);
        };
        if code_point == OPEN_BRACKET || code_point == CLOSE_BRACKET || code_point == HYPHEN {
            let shown = text_of(code_point);
            return failure(
                format!(
                    "holds {} inside a set. Write {} to match that code point there",
                    quoted(&shown),
                    quoted(&format!("\\{shown}"))
                ),
                start,
            );
        }
        if code_point != BACKSLASH {
            return Ok(SetMember::CodePoint(code_point));
        }
        let Some(escaped) = self.take() else {
            return failure(TRAILING_ESCAPE, start);
        };
        let name = class_escape(escaped);
        if let Some(name) = name.filter(|_| class_allowed) {
            return Ok(SetMember::Item(SetItem::Class(name)));
        }
        if is_ascii_punctuation(escaped) {
            return Ok(SetMember::CodePoint(escaped));
        }
        if name.is_some() {
            return failure(RANGE_ENDS_IN_CLASS, start);
        }
        failure(unknown_escape(escaped), start)
    }

    pub(super) fn parse_number_range(&mut self, start: usize) -> Parsed<Node> {
        let low = self.read_digits();
        let hyphen = self.take();
        let high = if hyphen == Some(HYPHEN) {
            self.read_digits()
        } else {
            Vec::new()
        };
        let closing = self.take();
        if low.is_empty() || high.is_empty() || closing != Some(GREATER) {
            return failure(
                format!(
                    r#"holds a "<" that doesn't open a number range such as <1-65535>. Each end of a number range holds from 1 to {MAX_NUMBER_RANGE_DIGITS} digits. Write "\<" to match the "<" itself"#
                ),
                start,
            );
        }
        if digits_value(&low) > digits_value(&high) {
            let shown = format!(
                "<{}-{}>",
                String::from_utf8_lossy(&low),
                String::from_utf8_lossy(&high)
            );
            return failure(
                format!(
                    "holds the number range {}, whose low end is above its high end",
                    quoted(&shown)
                ),
                start,
            );
        }
        let expansion_code_points = code_points_of(&number_range(&low, &high));
        let expansion = RegexReader::parse(&expansion_code_points)?;
        Ok(Node::NumberRange(Box::new(expansion)))
    }

    fn read_digits(&mut self) -> Vec<u8> {
        let mut digits = Vec::new();
        while let Some(digit) = self.peek(0).filter(|digit| is_digit(Some(*digit))) {
            if digits.len() == MAX_NUMBER_RANGE_DIGITS {
                return Vec::new();
            }
            digits.push(digit as u8);
            self.at += 1;
        }
        digits
    }
}
