use crate::engine::query::results::{HighlightMatch, HighlightPosition};

const ELLIPSIS: &str = "...";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Span {
    pub(super) start: usize,
    pub(super) end: usize,
}

pub(super) struct SnippetStyle<'a> {
    pub(super) pre_tag: &'a [u16],
    pub(super) post_tag: &'a [u16],
    pub(super) max_length: usize,
}

pub(super) fn merge_overlapping(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by_key(|span| span.start);
    let mut merged: Vec<Span> = Vec::with_capacity(spans.len());
    for span in spans {
        match merged.last_mut() {
            Some(previous) if span.start <= previous.end => {
                previous.end = previous.end.max(span.end)
            }
            _ => merged.push(span),
        }
    }
    merged
}

fn spans_within(spans: &[Span], start: usize, end: usize) -> &[Span] {
    let first = spans.partition_point(|span| span.start < start);
    let last = spans.partition_point(|span| span.end <= end);
    match first < last {
        true => &spans[first..last],
        false => &[],
    }
}

fn densest_window(spans: &[Span], length: usize, window: usize) -> (usize, usize) {
    let mut best_start = 0;
    let mut best_count = 0;
    for span in spans {
        let window_start = span.start.saturating_sub(window / 2);
        let window_end = length.min(window_start.saturating_add(window));
        let adjusted_start = window_end.saturating_sub(window);
        let count = spans_within(spans, adjusted_start, window_end).len();
        if count > best_count {
            best_count = count;
            best_start = adjusted_start;
        }
    }
    (best_start, length.min(best_start.saturating_add(window)))
}

fn tagged_forward(
    out: &mut Vec<u16>,
    text: &[u16],
    offset: usize,
    spans: &[Span],
    style: &SnippetStyle<'_>,
) {
    let mut cursor = 0;
    for span in spans {
        let (start, end) = (span.start - offset, span.end - offset);
        out.extend_from_slice(&text[cursor..start]);
        out.extend_from_slice(style.pre_tag);
        out.extend_from_slice(&text[start..end]);
        out.extend_from_slice(style.post_tag);
        cursor = end;
    }
    out.extend_from_slice(&text[cursor..]);
}

fn substring(text: &[u16], from: usize, to: usize) -> &[u16] {
    let (from, to) = (from.min(text.len()), to.min(text.len()));
    &text[from.min(to)..from.max(to)]
}

fn tagged_in_place(text: &[u16], spans: &[Span], style: &SnippetStyle<'_>) -> Vec<u16> {
    let mut result = text.to_vec();
    for span in spans.iter().rev() {
        let mut next =
            Vec::with_capacity(result.len() + style.pre_tag.len() + style.post_tag.len());
        next.extend_from_slice(substring(&result, 0, span.start));
        next.extend_from_slice(style.pre_tag);
        next.extend_from_slice(substring(&result, span.start, span.end));
        next.extend_from_slice(style.post_tag);
        next.extend_from_slice(substring(&result, span.end, result.len()));
        result = next;
    }
    result
}

fn positions_of(spans: &[Span]) -> Vec<HighlightPosition> {
    spans
        .iter()
        .map(|span| HighlightPosition {
            start: span.start,
            end: span.end,
        })
        .collect()
}

fn text_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn ellipsis_units() -> impl Iterator<Item = u16> {
    ELLIPSIS.encode_utf16()
}

fn truncated(text: &[u16], spans: &[Span], style: &SnippetStyle<'_>) -> HighlightMatch {
    let (start, end) = densest_window(spans, text.len(), style.max_length);
    let visible = spans_within(spans, start, end);
    let mut snippet: Vec<u16> = Vec::new();
    if start > 0 {
        snippet.extend(ellipsis_units());
    }
    tagged_forward(&mut snippet, &text[start..end], start, visible, style);
    if end < text.len() {
        snippet.extend(ellipsis_units());
    }
    HighlightMatch {
        snippet: text_of(&snippet),
        positions: positions_of(visible),
    }
}

pub(super) fn snippet_of(
    text: &[u16],
    spans: Vec<Span>,
    style: &SnippetStyle<'_>,
) -> HighlightMatch {
    let spans = merge_overlapping(spans);
    let shortens = style.max_length > 0 && text.len() > style.max_length;
    if spans.is_empty() {
        if !shortens {
            return HighlightMatch {
                snippet: text_of(text),
                positions: Vec::new(),
            };
        }
        let mut snippet = text[..style.max_length].to_vec();
        snippet.extend(ellipsis_units());
        return HighlightMatch {
            snippet: text_of(&snippet),
            positions: Vec::new(),
        };
    }
    if shortens {
        return truncated(text, &spans, style);
    }
    let within_text = spans.last().is_none_or(|span| span.end <= text.len());
    let snippet = match within_text {
        true => {
            let mut tagged = Vec::with_capacity(
                text.len() + spans.len() * (style.pre_tag.len() + style.post_tag.len()),
            );
            tagged_forward(&mut tagged, text, 0, &spans, style);
            tagged
        }
        false => tagged_in_place(text, &spans, style),
    };
    HighlightMatch {
        snippet: text_of(&snippet),
        positions: positions_of(&spans),
    }
}
