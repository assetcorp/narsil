use std::collections::HashMap;

use super::constants::{MIN_PHRASE_TABLE_CAPACITY, PAIR_BLOCK_SLOTS, PAIR_PAGE_BLOCKS};
use super::scramble::ScrambledId;
use super::types::RecordQueryOutcome;

const NO_BLOCK: u32 = u32::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DayLimits {
    pub(crate) min_people: u32,
    pub(crate) max_phrases_per_day: u32,
    pub(crate) max_phrases_per_person: u32,
    pub(crate) max_people_per_day: u32,
    pub(crate) max_groups: u32,
}

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

pub(crate) struct DayCounts {
    pub(crate) day: String,
    pub(crate) limits: DayLimits,
    groups: Vec<GroupTable>,
    group_numbers: HashMap<String, usize>,
    phrase_texts: Vec<Box<str>>,
    phrase_counts: Vec<u32>,
    people_lengths: Vec<u16>,
    people: Vec<ScrambledId>,
    persons: HashMap<ScrambledId, Person>,
    pair_pages: Vec<Box<[u16]>>,
    link_pages: Vec<Box<[u32]>>,
    blocks: u32,
    changed: bool,
}

fn block_place(block: u32) -> (usize, usize) {
    let block = block as usize;
    (block / PAIR_PAGE_BLOCKS, block % PAIR_PAGE_BLOCKS)
}

impl DayCounts {
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
            persons: HashMap::new(),
            pair_pages: Vec::new(),
            link_pages: Vec::new(),
            blocks: 0,
            changed: false,
        }
    }

    pub(crate) fn is_changed(&self) -> bool {
        self.changed
    }

    pub(crate) fn mark_saved(&mut self) {
        self.changed = false;
    }

    pub(crate) fn groups(&self) -> &[GroupTable] {
        &self.groups
    }

    pub(crate) fn has_group(&self, group: &str) -> bool {
        self.group_numbers.contains_key(group)
    }

    pub(crate) fn phrase_of(&self, number: u16) -> &str {
        self.phrase_texts
            .get(usize::from(number))
            .map_or("", |text| text)
    }

    pub(crate) fn count_of(&self, number: u16) -> u32 {
        self.phrase_counts
            .get(usize::from(number))
            .copied()
            .unwrap_or(0)
    }

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

    fn has_room_for_phrase(&self) -> bool {
        self.phrase_texts.len() < self.limits.max_phrases_per_day as usize
    }

    fn has_room_for_group(&self) -> bool {
        self.groups.len() < self.limits.max_groups as usize
    }

    pub(crate) fn count(
        &mut self,
        group: &str,
        phrase: &str,
        person: &ScrambledId,
        group_allowed: bool,
    ) -> RecordQueryOutcome {
        let existing = self.phrase_number(group, phrase);
        let known = self.persons.get(person).copied();
        if let (Some(number), Some(entry)) = (existing, &known)
            && self.person_has_phrase(entry, number)
        {
            return RecordQueryOutcome::Repeat;
        }
        if known.is_some_and(|entry| u32::from(entry.pairs) >= self.limits.max_phrases_per_person) {
            return RecordQueryOutcome::PersonLimit;
        }
        if existing.is_none() && !self.has_room_for_phrase() {
            return RecordQueryOutcome::PhraseLimit;
        }
        if known.is_none() && self.persons.len() >= self.limits.max_people_per_day as usize {
            return RecordQueryOutcome::PeopleLimit;
        }
        if !self.has_group(group) && (!group_allowed || !self.has_room_for_group()) {
            return RecordQueryOutcome::GroupLimit;
        }
        let number = match existing {
            Some(number) => number,
            None => self.add_phrase(group, phrase),
        };
        self.append_pair(person, number);
        if let Some(count) = self.phrase_counts.get_mut(usize::from(number)) {
            *count = count.saturating_add(1);
        }
        self.add_to_people(number, person);
        self.changed = true;
        RecordQueryOutcome::Recorded
    }

    pub(crate) fn restore_phrase(
        &mut self,
        group: &str,
        phrase: &str,
        count: u32,
        people: &[ScrambledId],
    ) -> bool {
        if self.phrase_number(group, phrase).is_some()
            || !self.has_room_for_phrase()
            || (!self.has_group(group) && !self.has_room_for_group())
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

    fn person_has_phrase(&self, person: &Person, number: u16) -> bool {
        let mut remaining = usize::from(person.pairs);
        let mut block = person.head;
        while block != NO_BLOCK && remaining > 0 {
            let (page, offset) = block_place(block);
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

    fn append_pair(&mut self, person: &ScrambledId, number: u16) {
        let mut entry = self.persons.get(person).copied().unwrap_or(Person {
            pairs: 0,
            head: NO_BLOCK,
            tail: NO_BLOCK,
        });
        let slot = usize::from(entry.pairs) % PAIR_BLOCK_SLOTS;
        if slot == 0 {
            let fresh = self.allocate_block();
            if entry.tail == NO_BLOCK {
                entry.head = fresh;
            } else {
                let (page, offset) = block_place(entry.tail);
                if let Some(link) = self
                    .link_pages
                    .get_mut(page)
                    .and_then(|links| links.get_mut(offset))
                {
                    *link = fresh;
                }
            }
            entry.tail = fresh;
        }
        let (page, offset) = block_place(entry.tail);
        if let Some(pair) = self
            .pair_pages
            .get_mut(page)
            .and_then(|pairs| pairs.get_mut(offset * PAIR_BLOCK_SLOTS + slot))
        {
            *pair = number;
        }
        entry.pairs = entry.pairs.saturating_add(1);
        self.persons.insert(*person, entry);
    }

    fn allocate_block(&mut self) -> u32 {
        let block = self.blocks;
        if (block as usize).is_multiple_of(PAIR_PAGE_BLOCKS) {
            self.pair_pages
                .push(vec![0u16; PAIR_PAGE_BLOCKS * PAIR_BLOCK_SLOTS].into_boxed_slice());
            self.link_pages
                .push(vec![NO_BLOCK; PAIR_PAGE_BLOCKS].into_boxed_slice());
        }
        self.blocks += 1;
        block
    }
}
