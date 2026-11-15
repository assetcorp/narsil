use narsil::Value;

use crate::errors::{ServerError, server_codes};

const NEWLINE: u8 = b'\n';
const CARRIAGE_RETURN: u8 = b'\r';

pub(crate) struct NdjsonLine {
    pub(crate) number: u64,
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) consumed: usize,
}

pub(crate) struct NdjsonLines<'a> {
    body: &'a [u8],
    start: usize,
    line_number: u64,
    max_line_bytes: u64,
}

impl<'a> NdjsonLines<'a> {
    pub(crate) fn new(body: &'a [u8], max_line_bytes: u64) -> NdjsonLines<'a> {
        NdjsonLines {
            body,
            start: 0,
            line_number: 0,
            max_line_bytes,
        }
    }
}

pub(crate) fn line_too_long(line: u64) -> ServerError {
    ServerError::new(
        413,
        server_codes::PAYLOAD_TOO_LARGE,
        format!("NDJSON line {line} exceeds the configured per-line size limit"),
    )
    .with_detail("line", Value::Number(line as f64))
}

impl Iterator for NdjsonLines<'_> {
    type Item = Result<NdjsonLine, ServerError>;

    fn next(&mut self) -> Option<Self::Item> {
        let length = self.body.len();
        while self.start < length {
            let rest = self.body.get(self.start..).unwrap_or_default();
            let end = rest
                .iter()
                .position(|byte| *byte == NEWLINE)
                .map_or(length, |offset| self.start + offset);
            if (end - self.start) as u64 > self.max_line_bytes {
                self.start = length;
                return Some(Err(line_too_long(self.line_number.saturating_add(1))));
            }
            let mut content_end = end;
            if content_end > self.start && self.body.get(content_end - 1) == Some(&CARRIAGE_RETURN)
            {
                content_end -= 1;
            }
            let start = self.start;
            self.start = end.saturating_add(1);
            if content_end > start {
                self.line_number = self.line_number.saturating_add(1);
                return Some(Ok(NdjsonLine {
                    number: self.line_number,
                    start,
                    end: content_end,
                    consumed: end.saturating_add(1).min(length),
                }));
            }
        }
        None
    }
}
