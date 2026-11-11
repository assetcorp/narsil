use jiff::Timestamp;
use jiff::civil::{Date, DateTime};
use jiff::tz::{AmbiguousOffset, TimeZone};

use super::constants::{DEFAULT_TIME_ZONE, MAX_SCHEDULE_LENGTH, SCHEDULE_LOOKAHEAD_DAYS};

const MINUTES: (u32, u32) = (0, 59);
const HOURS: (u32, u32) = (0, 23);
const DAYS_OF_MONTH: (u32, u32) = (1, 31);
const MONTHS: (u32, u32) = (1, 12);
const DAYS_OF_WEEK: (u32, u32) = (0, 6);
const STEPS: (u32, u32) = (1, 99);
const MAX_NUMBER_DIGITS: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Schedule {
    minutes: [bool; 60],
    hours: [bool; 24],
    days_of_month: [bool; 32],
    months: [bool; 13],
    days_of_week: [bool; 7],
    day_of_month_any: bool,
    day_of_week_any: bool,
}

fn parse_number(text: &str, range: (u32, u32)) -> Option<u32> {
    if text.is_empty()
        || text.len() > MAX_NUMBER_DIGITS
        || !text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let value: u32 = text.parse().ok()?;
    (range.0..=range.1).contains(&value).then_some(value)
}

fn parse_field<const N: usize>(text: &str, range: (u32, u32)) -> Option<[bool; N]> {
    let mut allowed = [false; N];
    for part in text.split(',') {
        let mut pieces = part.split('/');
        let base = pieces.next()?;
        let step_text = pieces.next();
        if pieces.next().is_some() {
            return None;
        }
        let step = match step_text {
            None => 1,
            Some(step) => parse_number(step, STEPS)?,
        };
        let (start, end) = if base == "*" {
            range
        } else {
            let mut bounds = base.split('-');
            let first = parse_number(bounds.next()?, range)?;
            let last = bounds.next();
            if bounds.next().is_some() {
                return None;
            }
            match last {
                Some(last) => {
                    let last = parse_number(last, range)?;
                    if last < first {
                        return None;
                    }
                    (first, last)
                }
                None if step_text.is_none() => (first, first),
                None => (first, range.1),
            }
        };
        let mut value = start;
        while value <= end {
            *allowed.get_mut(value as usize)? = true;
            value += step;
        }
    }
    Some(allowed)
}

pub(crate) fn parse_schedule(expression: &str) -> Option<Schedule> {
    if expression.len() > MAX_SCHEDULE_LENGTH {
        return None;
    }
    let fields: Vec<&str> = expression.split_whitespace().collect();
    let [minutes, hours, days_of_month, months, days_of_week] = fields[..] else {
        return None;
    };
    Some(Schedule {
        minutes: parse_field(minutes, MINUTES)?,
        hours: parse_field(hours, HOURS)?,
        days_of_month: parse_field(days_of_month, DAYS_OF_MONTH)?,
        months: parse_field(months, MONTHS)?,
        days_of_week: parse_field(days_of_week, DAYS_OF_WEEK)?,
        day_of_month_any: days_of_month == "*",
        day_of_week_any: days_of_week == "*",
    })
}

pub(crate) fn time_zone_named(name: &str) -> Option<TimeZone> {
    if name == DEFAULT_TIME_ZONE {
        return Some(TimeZone::UTC);
    }
    TimeZone::get(name).ok()
}

fn day_matches(schedule: &Schedule, date: Date) -> bool {
    let month = usize::try_from(date.month()).unwrap_or(0);
    if !schedule.months.get(month).copied().unwrap_or(false) {
        return false;
    }
    let day = usize::try_from(date.day()).unwrap_or(0);
    let weekday = usize::try_from(date.weekday().to_sunday_zero_offset()).unwrap_or(0);
    let month_day = schedule.days_of_month.get(day).copied().unwrap_or(false);
    let week_day = schedule.days_of_week.get(weekday).copied().unwrap_or(false);
    if !schedule.day_of_month_any && !schedule.day_of_week_any {
        return month_day || week_day;
    }
    month_day && week_day
}

fn instant_of(date: Date, hour: usize, minute: usize, zone: &TimeZone) -> Option<i64> {
    let wall = DateTime::new(
        date.year(),
        date.month(),
        date.day(),
        i8::try_from(hour).ok()?,
        i8::try_from(minute).ok()?,
        0,
        0,
    )
    .ok()?;
    let ambiguous = zone.to_ambiguous_timestamp(wall);
    if matches!(ambiguous.offset(), AmbiguousOffset::Gap { .. }) {
        return None;
    }
    ambiguous.compatible().ok().map(Timestamp::as_millisecond)
}

fn matches_of_day(schedule: &Schedule, date: Date, zone: &TimeZone) -> Vec<i64> {
    let mut instants = Vec::new();
    for (hour, _) in schedule.hours.iter().enumerate().filter(|(_, on)| **on) {
        for (minute, _) in schedule.minutes.iter().enumerate().filter(|(_, on)| **on) {
            if let Some(instant) = instant_of(date, hour, minute, zone) {
                instants.push(instant);
            }
        }
    }
    instants.sort_unstable();
    instants
}

fn nearest_match(
    schedule: &Schedule,
    zone: &TimeZone,
    instant_ms: i64,
    forwards: bool,
) -> Option<i64> {
    let later = |date: Date| date.tomorrow().ok();
    let earlier = |date: Date| date.yesterday().ok();
    let timestamp = Timestamp::from_millisecond(instant_ms).ok()?;
    let local = zone.to_datetime(timestamp).date();
    let mut date = if forwards {
        earlier(local)?
    } else {
        later(local)?
    };
    for _ in 0..=SCHEDULE_LOOKAHEAD_DAYS + 1 {
        if day_matches(schedule, date) {
            let mut instants = matches_of_day(schedule, date, zone).into_iter();
            let found = if forwards {
                instants.find(|instant| *instant > instant_ms)
            } else {
                instants.rfind(|instant| *instant <= instant_ms)
            };
            if found.is_some() {
                return found;
            }
        }
        date = if forwards {
            later(date)?
        } else {
            earlier(date)?
        };
    }
    None
}

pub(crate) fn next_match_after(schedule: &Schedule, zone: &TimeZone, after_ms: i64) -> Option<i64> {
    nearest_match(schedule, zone, after_ms, true)
}

pub(crate) fn latest_match_at_or_before(
    schedule: &Schedule,
    zone: &TimeZone,
    at_ms: i64,
) -> Option<i64> {
    nearest_match(schedule, zone, at_ms, false)
}
