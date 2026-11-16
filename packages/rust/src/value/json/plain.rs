use super::parse::parse_json_raw;
use super::write::write_json_string;
use crate::error::Result;
use crate::value::{Timestamp, Value, number_to_text};

/// Parses JSON text into a [`Value`] as `JSON.parse` reads it, keeping an object whose only key starts with `$`
/// as that object, so that an HTTP body holds exactly the fields that its sender wrote.
///
/// # Errors
///
/// Returns `DOC_VALIDATION_FAILED` where the text is not one JSON value, or where it nests deeper than 512 levels.
pub fn parse_plain_json(text: &str) -> Result<Value> {
    parse_json_raw(text)
}

/// Writes `value` as JSON text as `JSON.stringify` writes the same value in the TypeScript engine: a non-finite
/// number and negative zero as `null` and `0`, bytes as an array of numbers, and a timestamp as the text that
/// `Date.prototype.toISOString` gives the same instant, or as `null` beyond the range of a JavaScript `Date`, with
/// no tag objects.
pub fn write_plain_json(value: &Value) -> String {
    let mut out = String::new();
    write_plain_json_into(&mut out, value);
    out
}

/// Appends the text that [`write_plain_json`] returns for `value` to `out`.
pub fn write_plain_json_into(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => write_plain_number(out, *number),
        Value::String(text) => write_json_string(out, text),
        Value::Bytes(bytes) => {
            out.push('[');
            for (at, byte) in bytes.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                out.push_str(&byte.to_string());
            }
            out.push(']');
        }
        Value::Timestamp(timestamp) => write_plain_timestamp(out, timestamp),
        Value::Array(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_plain_json_into(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (at, (key, entry)) in map.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_json_string(out, key);
                out.push(':');
                write_plain_json_into(out, entry);
            }
            out.push('}');
        }
    }
}

fn write_plain_number(out: &mut String, number: f64) {
    if !number.is_finite() {
        out.push_str("null");
    } else if number == 0.0 {
        out.push('0');
    } else {
        out.push_str(&number_to_text(number));
    }
}

const DATE_MILLISECONDS_LIMIT: f64 = 8.64e15;
const NANOSECONDS_PER_MILLISECOND: f64 = 1e6;
const MILLISECONDS_PER_DAY: i64 = 86_400_000;
const MILLISECONDS_PER_HOUR: i64 = 3_600_000;
const MILLISECONDS_PER_MINUTE: i64 = 60_000;
const MILLISECONDS_PER_SECOND: i64 = 1_000;
const DAYS_FROM_YEAR_ZERO_MARCH_TO_EPOCH: i64 = 719_468;
const DAYS_PER_ERA: i64 = 146_097;
const YEARS_PER_ERA: i64 = 400;
const DAYS_PER_COMMON_YEAR: i64 = 365;
const LAST_DAY_OF_FIRST_FOUR_YEARS: i64 = 1_460;
const LAST_DAY_OF_FIRST_CENTURY: i64 = 36_524;
const LAST_DAY_OF_ERA: i64 = 146_096;
const YEARS_PER_LEAP_CYCLE: i64 = 4;
const YEARS_PER_CENTURY: i64 = 100;
const DAYS_PER_FIVE_MONTHS_FROM_MARCH: i64 = 153;
const MONTHS_PER_DAY_STEP: i64 = 5;
const MONTH_ROUNDING_DAYS: i64 = 2;
const MONTHS_FROM_MARCH_TO_DECEMBER: i64 = 10;
const MARCH: i64 = 3;
const FEBRUARY: i64 = 2;
const MONTHS_PER_YEAR: i64 = 12;
const FOUR_DIGIT_YEARS: std::ops::RangeInclusive<i64> = 0..=9999;

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + DAYS_FROM_YEAR_ZERO_MARCH_TO_EPOCH;
    let era = shifted.div_euclid(DAYS_PER_ERA);
    let day_of_era = shifted.rem_euclid(DAYS_PER_ERA);
    let year_of_era = (day_of_era - day_of_era / LAST_DAY_OF_FIRST_FOUR_YEARS
        + day_of_era / LAST_DAY_OF_FIRST_CENTURY
        - day_of_era / LAST_DAY_OF_ERA)
        / DAYS_PER_COMMON_YEAR;
    let day_of_year = day_of_era
        - (DAYS_PER_COMMON_YEAR * year_of_era + year_of_era / YEARS_PER_LEAP_CYCLE
            - year_of_era / YEARS_PER_CENTURY);
    let month_from_march =
        (MONTHS_PER_DAY_STEP * day_of_year + MONTH_ROUNDING_DAYS) / DAYS_PER_FIVE_MONTHS_FROM_MARCH;
    let day = day_of_year
        - (DAYS_PER_FIVE_MONTHS_FROM_MARCH * month_from_march + MONTH_ROUNDING_DAYS)
            / MONTHS_PER_DAY_STEP
        + 1;
    let month = match month_from_march < MONTHS_FROM_MARCH_TO_DECEMBER {
        true => month_from_march + MARCH,
        false => month_from_march + MARCH - MONTHS_PER_YEAR,
    };
    let year = year_of_era + era * YEARS_PER_ERA + i64::from(month <= FEBRUARY);
    (year, month, day)
}

fn write_plain_timestamp(out: &mut String, timestamp: &Timestamp) {
    let time = timestamp.seconds as f64 * MILLISECONDS_PER_SECOND as f64
        + f64::from(timestamp.nanoseconds) / NANOSECONDS_PER_MILLISECOND;
    if time.abs() > DATE_MILLISECONDS_LIMIT {
        out.push_str("null");
        return;
    }
    let milliseconds = time.trunc() as i64;
    let (year, month, day) = civil_from_days(milliseconds.div_euclid(MILLISECONDS_PER_DAY));
    let of_day = milliseconds.rem_euclid(MILLISECONDS_PER_DAY);
    let year = match FOUR_DIGIT_YEARS.contains(&year) {
        true => format!("{year:04}"),
        false if year < 0 => format!("-{:06}", year.unsigned_abs()),
        false => format!("+{year:06}"),
    };
    out.push_str(&format!(
        "\"{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z\"",
        of_day / MILLISECONDS_PER_HOUR,
        of_day % MILLISECONDS_PER_HOUR / MILLISECONDS_PER_MINUTE,
        of_day % MILLISECONDS_PER_MINUTE / MILLISECONDS_PER_SECOND,
        of_day % MILLISECONDS_PER_SECOND
    ));
}
