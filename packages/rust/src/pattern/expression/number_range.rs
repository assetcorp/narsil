fn all_digits_are(digits: &[u8], digit: u8) -> bool {
    !digits.is_empty() && digits.iter().all(|&each| each == digit)
}

fn push_digit(out: &mut String, digit: u8) {
    out.push(char::from(digit));
}

fn same_width(low: &[u8], high: &[u8], out: &mut String) {
    let width = low.len();
    if low == high {
        out.extend(low.iter().map(|&digit| char::from(digit)));
        return;
    }
    if all_digits_are(low, b'0') && all_digits_are(high, b'9') {
        out.push_str("[0-9]");
        if width != 1 {
            out.push_str(&format!("{{{width}}}"));
        }
        return;
    }
    let (Some(&low_lead), Some(&high_lead)) = (low.first(), high.first()) else {
        return;
    };
    if width == 1 {
        out.push('[');
        push_digit(out, low_lead);
        out.push('-');
        push_digit(out, high_lead);
        out.push(']');
        return;
    }
    let low_rest = &low[1..];
    let high_rest = &high[1..];
    if low_lead == high_lead {
        push_digit(out, low_lead);
        same_width(low_rest, high_rest, out);
        return;
    }
    let nines = vec![b'9'; width - 1];
    let zeros = vec![b'0'; width - 1];
    out.push('(');
    push_digit(out, low_lead);
    same_width(low_rest, &nines, out);
    let low_digit = low_lead - b'0';
    let high_digit = high_lead - b'0';
    if low_digit + 1 < high_digit {
        out.push_str(&format!("|[{}-{}]", low_digit + 1, high_digit - 1));
        for _ in 0..width - 1 {
            out.push_str("[0-9]");
        }
    }
    out.push('|');
    push_digit(out, high_lead);
    same_width(&zeros, high_rest, out);
    out.push(')');
}

pub(super) fn digits_value(digits: &[u8]) -> u64 {
    digits.iter().fold(0u64, |total, &digit| {
        total
            .saturating_mul(10)
            .saturating_add(u64::from(digit - b'0'))
    })
}

pub(super) fn number_range(low: &[u8], high: &[u8]) -> String {
    let mut out = String::new();
    if low.len() == high.len() {
        same_width(low, high, &mut out);
        return out;
    }
    let highest = digits_value(high);
    let mut start = digits_value(low);
    let widest = highest.to_string().len();
    let first_width = start.to_string().len();
    out.push('(');
    for width in first_width..=widest {
        let limit = 10u64.saturating_pow(width as u32) - 1;
        let last = highest.min(limit);
        if width != first_width {
            out.push('|');
        }
        same_width(
            start.to_string().as_bytes(),
            last.to_string().as_bytes(),
            &mut out,
        );
        start = limit + 1;
    }
    out.push(')');
    out
}
