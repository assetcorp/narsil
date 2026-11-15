use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use super::EngineInner;
use crate::durability::checkpoint_files::metadata_key;

#[derive(Default)]
struct Places {
    by_name: HashMap<String, u64>,
    next: u64,
}

#[derive(Default)]
pub(crate) struct ListingOrder {
    places: Mutex<Places>,
}

impl ListingOrder {
    fn places(&self) -> MutexGuard<'_, Places> {
        self.places
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn place(&self, name: &str) {
        let mut places = self.places();
        if places.by_name.contains_key(name) {
            return;
        }
        let next = places.next;
        places.by_name.insert(name.to_string(), next);
        places.next = next.saturating_add(1);
    }

    pub(crate) fn forget(&self, name: &str) {
        self.places().by_name.remove(name);
    }

    pub(crate) fn arrange<T>(&self, items: &mut [T], name_of: impl Fn(&T) -> &str) {
        let places = self.places();
        items.sort_by(|left, right| {
            let (left, right) = (name_of(left), name_of(right));
            let place_of = |name: &str| places.by_name.get(name).copied().unwrap_or(u64::MAX);
            place_of(left)
                .cmp(&place_of(right))
                .then_with(|| left.cmp(right))
        });
    }
}

pub(crate) fn place_recovered(engine: &EngineInner) {
    let (open, closed) = engine.held_indexes();
    let mut names: Vec<String> = open
        .iter()
        .map(|index| index.name.clone())
        .chain(closed.into_iter().map(|listing| listing.name))
        .collect();
    names.sort_by_cached_key(|name| metadata_key(name));
    for name in &names {
        engine.listing.place(name);
    }
}
