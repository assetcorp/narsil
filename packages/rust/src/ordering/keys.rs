use std::borrow::Cow;
use std::cmp::Ordering;

use super::constants::MAX_UNRANKED_SHARE_DIVISOR;
use super::fold::folded_code_points;
use super::{SortValue, reduced_sort_value};
use crate::engine::{SortDirection, SortMode};
use crate::value::Value;

#[derive(Clone, Debug)]
pub(crate) enum SortKey {
    Missing,
    Number(f64),
    Text { folded: Box<[u32]>, text: Box<str> },
    Bool(bool),
}

static MISSING_KEY: SortKey = SortKey::Missing;

impl SortKey {
    pub(crate) fn of(value: SortValue<'_>) -> SortKey {
        match value {
            SortValue::Missing => SortKey::Missing,
            SortValue::Number(number) => SortKey::Number(number),
            SortValue::Text(text) => SortKey::Text {
                folded: folded_code_points(text),
                text: text.into(),
            },
            SortValue::Bool(flag) => SortKey::Bool(flag),
        }
    }

    pub(crate) fn of_stored(value: Option<Cow<'_, Value>>, mode: SortMode) -> SortKey {
        match value {
            None => SortKey::Missing,
            Some(Cow::Borrowed(value)) => SortKey::of(reduced_sort_value(Some(value), mode)),
            Some(Cow::Owned(Value::Number(number))) if number.is_finite() => {
                SortKey::Number(number)
            }
            Some(Cow::Owned(_)) => SortKey::Missing,
        }
    }

    pub(crate) fn value(&self) -> SortValue<'_> {
        match self {
            SortKey::Missing => SortValue::Missing,
            SortKey::Number(number) => SortValue::Number(*number),
            SortKey::Text { text, .. } => SortValue::Text(text),
            SortKey::Bool(flag) => SortValue::Bool(*flag),
        }
    }

    fn type_rank(&self) -> u8 {
        match self {
            SortKey::Number(_) => 0,
            SortKey::Text { .. } => 1,
            _ => 2,
        }
    }
}

fn compare_present_keys(left: &SortKey, right: &SortKey) -> Ordering {
    match (left, right) {
        (SortKey::Number(one), SortKey::Number(other)) => {
            one.partial_cmp(other).unwrap_or(Ordering::Equal)
        }
        (
            SortKey::Text {
                folded: one,
                text: one_text,
            },
            SortKey::Text {
                folded: other,
                text: other_text,
            },
        ) => one.cmp(other).then_with(|| one_text.cmp(other_text)),
        (SortKey::Bool(one), SortKey::Bool(other)) => one.cmp(other),
        _ => left.type_rank().cmp(&right.type_rank()),
    }
}

pub(crate) fn compare_keys(left: &SortKey, right: &SortKey, direction: SortDirection) -> Ordering {
    match (left, right) {
        (SortKey::Missing, SortKey::Missing) => Ordering::Equal,
        (SortKey::Missing, _) => Ordering::Greater,
        (_, SortKey::Missing) => Ordering::Less,
        _ => {
            let comparison = compare_present_keys(left, right);
            match direction {
                SortDirection::Asc => comparison,
                SortDirection::Desc => comparison.reverse(),
            }
        }
    }
}

const MISSING_RANK: u32 = u32::MAX;

#[derive(Clone, Default)]
pub(crate) struct KeyColumn {
    keys: Vec<SortKey>,
    ranks: Vec<u32>,
}

fn dense_ranks(keys: &[SortKey]) -> Vec<u32> {
    let mut order: Vec<u32> = (0..keys.len() as u32)
        .filter(|at| !matches!(keys[*at as usize], SortKey::Missing))
        .collect();
    order.sort_unstable_by(|left, right| {
        compare_present_keys(&keys[*left as usize], &keys[*right as usize])
    });
    let mut ranks = vec![MISSING_RANK; keys.len()];
    let mut rank = 0u32;
    for (place, at) in order.iter().enumerate() {
        if place > 0 {
            let previous = &keys[order[place - 1] as usize];
            if compare_present_keys(previous, &keys[*at as usize]) != Ordering::Equal {
                rank += 1;
            }
        }
        ranks[*at as usize] = rank;
    }
    ranks
}

impl KeyColumn {
    pub(crate) fn len(&self) -> usize {
        self.keys.len()
    }

    pub(crate) fn key(&self, ordinal: u32) -> &SortKey {
        self.keys.get(ordinal as usize).unwrap_or(&MISSING_KEY)
    }

    pub(crate) fn extend(&mut self, keys: impl Iterator<Item = SortKey>) {
        self.keys.extend(keys);
        let unranked = self.keys.len() - self.ranks.len();
        if unranked > 0 && unranked * MAX_UNRANKED_SHARE_DIVISOR >= self.keys.len() {
            self.ranks = dense_ranks(&self.keys);
        }
    }

    pub(crate) fn compare_at(&self, left: u32, right: u32, direction: SortDirection) -> Ordering {
        let (Some(one), Some(other)) = (
            self.ranks.get(left as usize),
            self.ranks.get(right as usize),
        ) else {
            return compare_keys(self.key(left), self.key(right), direction);
        };
        match (*one == MISSING_RANK, *other == MISSING_RANK) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => match direction {
                SortDirection::Asc => one.cmp(other),
                SortDirection::Desc => other.cmp(one),
            },
        }
    }
}
