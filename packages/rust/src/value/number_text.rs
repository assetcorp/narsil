const LARGEST_PLAIN_EXPONENT: i32 = 21;
const SMALLEST_PLAIN_EXPONENT: i32 = -6;

/// Writes a number the way ECMAScript's `Number.prototype.toString` writes it, with the shortest digits that
/// read back as the same float64.
pub(crate) fn number_to_text(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_string();
    }
    if number == 0.0 {
        return "0".to_string();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_string();
    }
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .unwrap_or((scientific.as_str(), "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let count = digits.len() as i32;
    let point = exponent + 1;
    let mut text = String::with_capacity(digits.len() + 8);
    if number < 0.0 {
        text.push('-');
    }
    if count <= point && point <= LARGEST_PLAIN_EXPONENT {
        text.push_str(&digits);
        text.extend(std::iter::repeat_n('0', (point - count) as usize));
    } else if 0 < point && point <= LARGEST_PLAIN_EXPONENT {
        text.push_str(&digits[..point as usize]);
        text.push('.');
        text.push_str(&digits[point as usize..]);
    } else if SMALLEST_PLAIN_EXPONENT < point && point <= 0 {
        text.push_str("0.");
        text.extend(std::iter::repeat_n('0', (-point) as usize));
        text.push_str(&digits);
    } else {
        text.push_str(&digits[..1]);
        if count > 1 {
            text.push('.');
            text.push_str(&digits[1..]);
        }
        text.push('e');
        text.push(if point > 0 { '+' } else { '-' });
        text.push_str(&(point - 1).abs().to_string());
    }
    text
}
