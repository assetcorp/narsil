use crate::script_values::javascript_trim;

const RANGE_UNIT_PREFIX: &str = "bytes=";
const LONGEST_RANGE_NUMBER_DIGITS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RangeAnswer {
    Whole,
    Partial { start: u64, end_exclusive: u64 },
    Unsatisfiable,
}

fn if_range_matches(if_range: Option<&str>, entity_tag: &str) -> bool {
    match if_range {
        None => true,
        Some(given) => {
            let trimmed = javascript_trim(given);
            trimmed.len() == entity_tag.len() + 2
                && trimmed.starts_with('"')
                && trimmed.ends_with('"')
                && trimmed.get(1..trimmed.len() - 1) == Some(entity_tag)
        }
    }
}

fn digits(text: &str) -> Option<&str> {
    (text.len() <= LONGEST_RANGE_NUMBER_DIGITS && text.bytes().all(|byte| byte.is_ascii_digit()))
        .then_some(text)
}

fn number_of(digits: &str) -> f64 {
    digits.parse::<f64>().unwrap_or(f64::INFINITY)
}

fn offset_of(number: f64, length: u64) -> u64 {
    if number <= 0.0 {
        0
    } else if number >= length as f64 {
        length
    } else {
        number as u64
    }
}

pub(crate) fn range_of(
    range: Option<&str>,
    if_range: Option<&str>,
    entity_tag: &str,
    length: u64,
) -> RangeAnswer {
    let Some(range) = range else {
        return RangeAnswer::Whole;
    };
    if !if_range_matches(if_range, entity_tag) {
        return RangeAnswer::Whole;
    }
    let Some(spec) = javascript_trim(range).strip_prefix(RANGE_UNIT_PREFIX) else {
        return RangeAnswer::Whole;
    };
    let Some((first, last)) = spec.split_once('-') else {
        return RangeAnswer::Whole;
    };
    let (Some(first), Some(last)) = (digits(first), digits(last)) else {
        return RangeAnswer::Whole;
    };
    let whole_length = length as f64;
    match (first.is_empty(), last.is_empty()) {
        (true, true) => RangeAnswer::Whole,
        (true, false) => {
            let suffix = number_of(last);
            if suffix == 0.0 || length == 0 {
                return RangeAnswer::Unsatisfiable;
            }
            RangeAnswer::Partial {
                start: offset_of(whole_length - suffix, length),
                end_exclusive: length,
            }
        }
        (false, _) => {
            let start = number_of(first);
            if !last.is_empty() && number_of(last) < start {
                return RangeAnswer::Whole;
            }
            if start >= whole_length {
                return RangeAnswer::Unsatisfiable;
            }
            let end_exclusive = if last.is_empty() {
                length
            } else {
                offset_of(number_of(last) + 1.0, length)
            };
            RangeAnswer::Partial {
                start: offset_of(start, length),
                end_exclusive,
            }
        }
    }
}
