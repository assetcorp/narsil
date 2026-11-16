use super::listing::javascript_trim;

fn radix_value(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut value = 0.0_f64;
    for character in digits.chars() {
        let Some(digit) = character.to_digit(radix) else {
            return f64::NAN;
        };
        value = value * f64::from(radix) + f64::from(digit);
    }
    value
}

fn digit_run(bytes: &[u8], at: usize) -> usize {
    bytes.get(at..).map_or(0, |rest| {
        rest.iter().take_while(|byte| byte.is_ascii_digit()).count()
    })
}

fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut at = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let whole = digit_run(bytes, at);
    at += whole;
    let mut fraction = 0;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        fraction = digit_run(bytes, at);
        at += fraction;
    }
    if whole == 0 && fraction == 0 {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exponent = digit_run(bytes, at);
        if exponent == 0 {
            return false;
        }
        at += exponent;
    }
    at == bytes.len()
}

pub(crate) fn number_of_text(raw: &str) -> f64 {
    let text = javascript_trim(raw);
    if text.is_empty() {
        return 0.0;
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let prefixed = [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ];
    for (prefix, radix) in prefixed {
        if let Some(digits) = text.strip_prefix(prefix) {
            return radix_value(digits, radix);
        }
    }
    if !is_decimal_literal(text) {
        return f64::NAN;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}
