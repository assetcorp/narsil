use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Map, Value};

const MAX_JSON_DEPTH: usize = 512;

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    at: usize,
}

fn invalid(reason: String) -> NarsilError {
    NarsilError::new(
        ErrorCode::DOC_VALIDATION_FAILED,
        format!("The text is not valid JSON: {reason}"),
    )
}

impl<'a> Parser<'a> {
    fn whitespace(&mut self) {
        while self.at < self.bytes.len()
            && matches!(self.bytes[self.at], b' ' | b'\t' | b'\n' | b'\r')
        {
            self.at += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<()> {
        if self.bytes.get(self.at) == Some(&byte) {
            self.at += 1;
            return Ok(());
        }
        Err(invalid(format!(
            "expected '{}' at byte {}",
            byte as char, self.at
        )))
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value> {
        if self.text[self.at..].starts_with(word) {
            self.at += word.len();
            return Ok(value);
        }
        Err(invalid(format!("unexpected text at byte {}", self.at)))
    }

    fn hex4(&mut self) -> Result<u32> {
        let digits = self
            .text
            .get(self.at..self.at + 4)
            .ok_or_else(|| invalid("a \\u escape is short".into()))?;
        let unit = u32::from_str_radix(digits, 16)
            .map_err(|_| invalid("a \\u escape is not hexadecimal".into()))?;
        self.at += 4;
        Ok(unit)
    }

    fn string(&mut self) -> Result<String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let start = self.at;
            while self.at < self.bytes.len()
                && !matches!(self.bytes[self.at], b'"' | b'\\')
                && self.bytes[self.at] >= 0x20
            {
                self.at += 1;
            }
            out.push_str(&self.text[start..self.at]);
            match self.bytes.get(self.at) {
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let escape = *self
                        .bytes
                        .get(self.at)
                        .ok_or_else(|| invalid("a string ends in an escape".into()))?;
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            let scalar = if (0xd800..0xdc00).contains(&unit) {
                                if !self.text[self.at..].starts_with("\\u") {
                                    return Err(invalid("a string holds a lone surrogate".into()));
                                }
                                self.at += 2;
                                let low = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&low) {
                                    return Err(invalid("a string holds a lone surrogate".into()));
                                }
                                0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)
                            } else if (0xdc00..0xe000).contains(&unit) {
                                return Err(invalid("a string holds a lone surrogate".into()));
                            } else {
                                unit
                            };
                            out.push(
                                char::from_u32(scalar)
                                    .ok_or_else(|| invalid("a \\u escape is invalid".into()))?,
                            );
                        }
                        _ => {
                            return Err(invalid(format!(
                                "a string holds an unknown escape at byte {}",
                                self.at
                            )));
                        }
                    }
                }
                _ => {
                    return Err(invalid(
                        "a string is unterminated or holds a control character".into(),
                    ));
                }
            }
        }
    }

    fn number(&mut self) -> Result<Value> {
        let start = self.at;
        if self.bytes.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        let digits = |parser: &mut Parser<'_>| {
            let begin = parser.at;
            while parser.at < parser.bytes.len() && parser.bytes[parser.at].is_ascii_digit() {
                parser.at += 1;
            }
            parser.at - begin
        };
        let integer_start = self.at;
        let integer_digits = digits(self);
        if integer_digits == 0 || (integer_digits > 1 && self.bytes[integer_start] == b'0') {
            return Err(invalid(format!("a number at byte {start} is malformed")));
        }
        if self.bytes.get(self.at) == Some(&b'.') {
            self.at += 1;
            if digits(self) == 0 {
                return Err(invalid(format!("a number at byte {start} is malformed")));
            }
        }
        if matches!(self.bytes.get(self.at), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.bytes.get(self.at), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if digits(self) == 0 {
                return Err(invalid(format!("a number at byte {start} is malformed")));
            }
        }
        let number: f64 = self.text[start..self.at]
            .parse()
            .map_err(|_| invalid("a number is malformed".into()))?;
        Ok(Value::Number(number))
    }

    fn value(&mut self, depth: usize) -> Result<Value> {
        if depth > MAX_JSON_DEPTH {
            return Err(invalid(format!(
                "the text nests deeper than {MAX_JSON_DEPTH} levels"
            )));
        }
        self.whitespace();
        match self.bytes.get(self.at) {
            Some(b'{') => {
                self.at += 1;
                let mut map = Map::new();
                self.whitespace();
                if self.bytes.get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Ok(Value::Object(map));
                }
                loop {
                    self.whitespace();
                    let key = self.string()?;
                    self.whitespace();
                    self.expect(b':')?;
                    let entry = self.value(depth + 1)?;
                    map.insert(key, entry);
                    self.whitespace();
                    match self.bytes.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(Value::Object(map));
                        }
                        _ => {
                            return Err(invalid(format!(
                                "expected ',' or '}}' at byte {}",
                                self.at
                            )));
                        }
                    }
                }
            }
            Some(b'[') => {
                self.at += 1;
                let mut items = Vec::new();
                self.whitespace();
                if self.bytes.get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Ok(Value::Array(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.whitespace();
                    match self.bytes.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Value::Array(items));
                        }
                        _ => {
                            return Err(invalid(format!(
                                "expected ',' or ']' at byte {}",
                                self.at
                            )));
                        }
                    }
                }
            }
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b't') => self.literal("true", Value::Bool(true)),
            Some(b'f') => self.literal("false", Value::Bool(false)),
            Some(b'n') => self.literal("null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(invalid(format!("unexpected text at byte {}", self.at))),
        }
    }
}

/// Parses JSON text into a [`Value`] and keeps every tag object as it is written.
pub(crate) fn parse_json_raw(text: &str) -> Result<Value> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        text,
        at: 0,
    };
    let value = parser.value(1)?;
    parser.whitespace();
    if parser.at != text.len() {
        return Err(invalid(format!(
            "text follows the value at byte {}",
            parser.at
        )));
    }
    Ok(value)
}
