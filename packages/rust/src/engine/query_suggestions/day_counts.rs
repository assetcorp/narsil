use std::collections::HashMap;

use super::constants::{
    MIN_PERSON_TABLE_CAPACITY, MIN_PHRASE_TABLE_CAPACITY, PAIR_BLOCK_SLOTS, PAIR_PAGE_BLOCKS,
};
use super::scramble::ScrambledId;

const NO_BLOCK: u32 = u32::MAX;

/// The limits of one day's counts, which the setting of the index sets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DayLimits {
    pub(crate) min_people: u32,
    pub(crate) max_phrases_per_day: u32,
    pub(crate) max_phrases_per_person: u32,
    pub(crate) max_people_per_day: u32,
    pub(crate) max_groups: u32,
}

/// What counting one search did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CountOutcome {
    Recorded,
    Repeat,
    PersonLimit,
    PhraseLimit,
    PeopleLimit,
    GroupLimit,
}

/// The phrases of one group, in the order that the day first counted them.
pub(crate) struct GroupTable {
    pub(crate) name: String,
    numbers: HashMap<Box<str>, u16>,
    pub(crate) order: Vec<u16>,
}

#[derive(Clone, Copy)]
struct Person {
    pairs: u16,
    head: u32,
    tail: u32,
}

/// The searches of one day for one index, held in fixed-size tables that the limits of the setting bound.
pub(crate) struct DayCounts {
    pub(crate) day: String,
    pub(crate) limits: DayLimits,
    groups: Vec<GroupTable>,
    group_numbers: HashMap<String, usize>,
    phrase_texts: Vec<Box<str>>,
    phrase_counts: Vec<u32>,
    people_lengths: Vec<u16>,
    people: Vec<ScrambledId>,
    persons: Vec<Person>,
    person_numbers: HashMap<ScrambledId, u32>,
    pair_pages: Vec<Box<[u16]>>,
    link_pages: Vec<Box<[u32]>>,
    blocks: u32,
    changed: bool,
}

impl DayCounts {
    /// Returns empty counts for `day` that keep within `limits`.
    pub(crate) fn new(day: String, limits: DayLimits) -> DayCounts {
        DayCounts {
            day,
            limits,
            groups: Vec::new(),
            group_numbers: HashMap::new(),
            phrase_texts: Vec::new(),
            phrase_counts: Vec::new(),
            people_lengths: Vec::new(),
            people: Vec::new(),
            persons: Vec::new(),
            person_numbers: HashMap::new(),
            pair_pages: Vec::new(),
            link_pages: Vec::new(),
            blocks: 0,
            changed: false,
        }
    }

    /// Returns the number of distinct phrases that the day holds.
    pub(crate) fn phrases(&self) -> usize {
        self.phrase_texts.len()
    }

    /// Returns the number of distinct people that the day counted.
    pub(crate) fn people(&self) -> usize {
        self.persons.len()
    }

    /// Reports whether the day changed since its last save.
    pub(crate) fn is_changed(&self) -> bool {
        self.changed
    }

    /// Records that a save wrote every count that the day holds.
    pub(crate) fn mark_saved(&mut self) {
        self.changed = false;
    }

    /// Returns the groups that the day holds, in the order that it first counted them.
    pub(crate) fn groups(&self) -> &[GroupTable] {
        &self.groups
    }

    /// Reports whether the day holds a phrase of `group`.
    pub(crate) fn has_group(&self, group: &str) -> bool {
        self.group_numbers.contains_key(group)
    }

    /// Returns the text of the phrase numbered `number`.
    pub(crate) fn phrase_of(&self, number: u16) -> &str {
        self.phrase_texts
            .get(usize::from(number))
            .map_or("", |text| text)
    }

    /// Returns the number of searches of the phrase numbered `number`.
    pub(crate) fn count_of(&self, number: u16) -> u32 {
        self.phrase_counts
            .get(usize::from(number))
            .copied()
            .unwrap_or(0)
    }

    /// Returns the people of the phrase numbered `number`, up to the minimum that publishing needs.
    pub(crate) fn people_of(&self, number: u16) -> &[ScrambledId] {
        let index = usize::from(number);
        let length = self
            .people_lengths
            .get(index)
            .copied()
            .map_or(0, usize::from);
        let start = index * self.stride();
        self.people.get(start..start + length).unwrap_or(&[])
    }

    fn stride(&self) -> usize {
        self.limits.min_people as usize
    }

    fn phrase_number(&self, group: &str, phrase: &str) -> Option<u16> {
        let table = self.groups.get(*self.group_numbers.get(group)?)?;
        table.numbers.get(phrase).copied()
    }

    /// Counts one search of `phrase` in `group` by the person whose scrambled ID is `person`.
    pub(crate) fn count(
        &mut self,
        group: &str,
        phrase: &str,
        person: &ScrambledId,
        group_allowed: bool,
    ) -> CountOutcome {
        let existing = self.phrase_number(group, phrase);
        let known = self.person_numbers.get(person).copied();
        if let (Some(number), Some(at)) = (existing, known)
            && self.person_has_phrase(at, number)
        {
            return CountOutcome::Repeat;
        }
        if let Some(at) = known
            && self
                .persons
                .get(at as usize)
                .is_some_and(|entry| u32::from(entry.pairs) >= self.limits.max_phrases_per_person)
        {
            return CountOutcome::PersonLimit;
        }
        if existing.is_none() && self.phrases() >= self.limits.max_phrases_per_day as usize {
            return CountOutcome::PhraseLimit;
        }
        if known.is_none() && self.people() >= self.limits.max_people_per_day as usize {
            return CountOutcome::PeopleLimit;
        }
        if !self.has_group(group)
            && (!group_allowed || self.groups.len() >= self.limits.max_groups as usize)
        {
            return CountOutcome::GroupLimit;
        }
        let number = match existing {
            Some(number) => number,
            None => self.add_phrase(group, phrase),
        };
        let at = match known {
            Some(at) => at,
            None => self.add_person(*person),
        };
        self.append_pair(at, number);
        if let Some(count) = self.phrase_counts.get_mut(usize::from(number)) {
            *count = count.saturating_add(1);
        }
        self.add_to_people(number, person);
        self.changed = true;
        CountOutcome::Recorded
    }

    /// Adds a phrase that a saved file holds, returning `false` where the day holds it already or has no room.
    pub(crate) fn restore_phrase(
        &mut self,
        group: &str,
        phrase: &str,
        count: u32,
        people: &[ScrambledId],
    ) -> bool {
        if self.phrase_number(group, phrase).is_some()
            || self.phrases() >= self.limits.max_phrases_per_day as usize
            || (!self.has_group(group) && self.groups.len() >= self.limits.max_groups as usize)
        {
            return false;
        }
        let number = self.add_phrase(group, phrase);
        for person in people {
            self.add_to_people(number, person);
        }
        let index = usize::from(number);
        let listed = self.people_lengths.get(index).copied().map_or(0, u32::from);
        if let Some(slot) = self.phrase_counts.get_mut(index) {
            *slot = count.max(listed);
        }
        true
    }

    fn add_phrase(&mut self, group: &str, phrase: &str) -> u16 {
        let number = u16::try_from(self.phrase_texts.len()).unwrap_or(u16::MAX);
        if self.phrase_texts.len() == self.phrase_counts.len() {
            self.grow_phrases();
        }
        let at = match self.group_numbers.get(group) {
            Some(at) => *at,
            None => {
                self.groups.push(GroupTable {
                    name: group.to_string(),
                    numbers: HashMap::new(),
                    order: Vec::new(),
                });
                self.group_numbers
                    .insert(group.to_string(), self.groups.len() - 1);
                self.groups.len() - 1
            }
        };
        if let Some(table) = self.groups.get_mut(at) {
            table.numbers.insert(phrase.into(), number);
            table.order.push(number);
        }
        self.phrase_texts.push(phrase.into());
        number
    }

    fn grow_phrases(&mut self) {
        let capacity = (self.phrase_counts.len() * 2)
            .max(MIN_PHRASE_TABLE_CAPACITY)
            .min(self.limits.max_phrases_per_day as usize)
            .max(self.phrase_counts.len() + 1);
        self.phrase_counts.resize(capacity, 0);
        self.people_lengths.resize(capacity, 0);
        self.people.resize(capacity * self.stride(), [0; 16]);
    }

    fn add_to_people(&mut self, number: u16, person: &ScrambledId) {
        let index = usize::from(number);
        let stride = self.stride();
        let Some(length) = self.people_lengths.get(index).copied() else {
            return;
        };
        let length = usize::from(length);
        if length >= stride {
            return;
        }
        let start = index * stride;
        let listed = self.people.get(start..start + length).unwrap_or(&[]);
        if listed.contains(person) {
            return;
        }
        if let Some(slot) = self.people.get_mut(start + length) {
            *slot = *person;
            if let Some(stored) = self.people_lengths.get_mut(index) {
                *stored += 1;
            }
        }
    }

    fn add_person(&mut self, person: ScrambledId) -> u32 {
        if self.persons.len() == self.persons.capacity() {
            let wanted = (self.persons.capacity() * 2)
                .max(MIN_PERSON_TABLE_CAPACITY / 2)
                .min(self.limits.max_people_per_day as usize)
                .max(self.persons.len() + 1);
            self.persons.reserve_exact(wanted - self.persons.len());
            self.person_numbers
                .reserve(wanted - self.person_numbers.len());
        }
        let at = u32::try_from(self.persons.len()).unwrap_or(u32::MAX);
        self.persons.push(Person {
            pairs: 0,
            head: NO_BLOCK,
            tail: NO_BLOCK,
        });
        self.person_numbers.insert(person, at);
        at
    }

    fn block_place(block: u32) -> (usize, usize) {
        let block = block as usize;
        (block / PAIR_PAGE_BLOCKS, block % PAIR_PAGE_BLOCKS)
    }

    fn person_has_phrase(&self, at: u32, number: u16) -> bool {
        let Some(person) = self.persons.get(at as usize) else {
            return false;
        };
        let mut remaining = usize::from(person.pairs);
        let mut block = person.head;
        while block != NO_BLOCK && remaining > 0 {
            let (page, offset) = Self::block_place(block);
            let used = remaining.min(PAIR_BLOCK_SLOTS);
            let start = offset * PAIR_BLOCK_SLOTS;
            let slots = self
                .pair_pages
                .get(page)
                .and_then(|pairs| pairs.get(start..start + used));
            if slots.is_some_and(|slots| slots.contains(&number)) {
                return true;
            }
            remaining -= used;
            block = self
                .link_pages
                .get(page)
                .and_then(|links| links.get(offset))
                .copied()
                .unwrap_or(NO_BLOCK);
        }
        false
    }

    fn append_pair(&mut self, at: u32, number: u16) {
        let Some(person) = self.persons.get(at as usize).copied() else {
            return;
        };
        let slot = usize::from(person.pairs) % PAIR_BLOCK_SLOTS;
        let mut block = person.tail;
        let mut head = person.head;
        if slot == 0 {
            let fresh = self.allocate_block();
            if block == NO_BLOCK {
                head = fresh;
            } else {
                let (page, offset) = Self::block_place(block);
                if let Some(link) = self
                    .link_pages
                    .get_mut(page)
                    .and_then(|links| links.get_mut(offset))
                {
                    *link = fresh;
                }
            }
            block = fresh;
        }
        let (page, offset) = Self::block_place(block);
        if let Some(pair) = self
            .pair_pages
            .get_mut(page)
            .and_then(|pairs| pairs.get_mut(offset * PAIR_BLOCK_SLOTS + slot))
        {
            *pair = number;
        }
        if let Some(entry) = self.persons.get_mut(at as usize) {
            entry.head = head;
            entry.tail = block;
            entry.pairs = entry.pairs.saturating_add(1);
        }
    }

    fn allocate_block(&mut self) -> u32 {
        let block = self.blocks;
        if block as usize % PAIR_PAGE_BLOCKS == 0 {
            self.pair_pages
                .push(vec![0u16; PAIR_PAGE_BLOCKS * PAIR_BLOCK_SLOTS].into_boxed_slice());
            self.link_pages
                .push(vec![NO_BLOCK; PAIR_PAGE_BLOCKS].into_boxed_slice());
        }
        self.blocks += 1;
        block
    }
}
