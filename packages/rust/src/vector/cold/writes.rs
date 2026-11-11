use crate::error::Result;

use super::super::field::{Shared, Writer};
use super::super::writes::{insert_stamped, remove_stamped};
use super::{ColdHold, HoldState, Progress};

#[derive(Debug, Clone, Copy)]
pub(super) struct RetiredCopy {
    pub(super) number: u32,
    pub(super) sequence: i64,
}

pub(super) enum HeldWrite {
    Insert {
        doc_id: String,
        vector: Vec<f32>,
        sequence: i64,
    },
    Remove {
        doc_id: String,
        sequence: i64,
    },
}

impl HeldWrite {
    pub(super) fn memory_bytes(&self) -> usize {
        match self {
            HeldWrite::Insert { doc_id, vector, .. } => {
                doc_id.len() + vector.len() * size_of::<f32>()
            }
            HeldWrite::Remove { doc_id, .. } => doc_id.len(),
        }
    }
}

pub(crate) struct ColdView {
    pub(crate) live: u64,
    pub(crate) excluded: Vec<u32>,
}

fn takes_writes(state: &HoldState) -> bool {
    !matches!(state.progress, Progress::Ended | Progress::Cancelled)
}

impl ColdHold {
    fn copy_in_files(&self, doc_id: &str) -> Result<Option<u32>> {
        let known = {
            let state = self.lock();
            !takes_writes(&state) || state.retired.contains_key(doc_id)
        };
        if known {
            return Ok(None);
        }
        self.field.number_of(doc_id)
    }

    fn retire(state: &mut HoldState, doc_id: &str, number: Option<u32>, sequence: i64) {
        if let Some(number) = number
            && !state.retired.contains_key(doc_id)
        {
            state
                .retired
                .insert(doc_id.to_string(), RetiredCopy { number, sequence });
        }
    }

    pub(crate) fn insert(&self, doc_id: &str, vector: &[f32], sequence: i64) -> Result<bool> {
        let number = self.copy_in_files(doc_id)?;
        let mut state = self.lock();
        if !takes_writes(&state) {
            return Ok(false);
        }
        {
            let held = &self.held.shared;
            let mut writer = held.lock_writer();
            insert_stamped(held, &mut writer, doc_id, vector, sequence)?;
        }
        ColdHold::retire(&mut state, doc_id, number, sequence);
        state.writes.push(HeldWrite::Insert {
            doc_id: doc_id.to_string(),
            vector: vector.to_vec(),
            sequence,
        });
        Ok(true)
    }

    pub(crate) fn remove(&self, doc_id: &str, sequence: i64) -> Result<bool> {
        let number = self.copy_in_files(doc_id)?;
        let mut state = self.lock();
        if !takes_writes(&state) {
            return Ok(false);
        }
        remove_stamped(&mut self.held.shared.lock_writer(), doc_id, sequence)?;
        ColdHold::retire(&mut state, doc_id, number, sequence);
        state.writes.push(HeldWrite::Remove {
            doc_id: doc_id.to_string(),
            sequence,
        });
        Ok(true)
    }

    pub(crate) fn view(&self, pin: i64) -> ColdView {
        let state = self.lock();
        let retired = state.retired.len() as u64;
        let held = self.held.shared.current().counts.live();
        let mut excluded: Vec<u32> = state
            .retired
            .values()
            .filter(|copy| copy.sequence <= pin)
            .map(|copy| copy.number)
            .collect();
        excluded.sort_unstable();
        ColdView {
            live: self.field.live_count().saturating_sub(retired) + held,
            excluded,
        }
    }

    fn visible_number(&self, doc_id: &str, pin: i64) -> Result<Option<u32>> {
        let Some(number) = self.field.number_of(doc_id)? else {
            return Ok(None);
        };
        let retired = self
            .lock()
            .retired
            .get(doc_id)
            .is_some_and(|copy| copy.sequence <= pin);
        Ok((!retired).then_some(number))
    }

    pub(crate) fn pinned_vector(&self, doc_id: &str, pin: i64) -> Result<Option<Vec<f32>>> {
        if let Some(vector) = self.held.pinned_vector(doc_id, pin)? {
            return Ok(Some(vector));
        }
        self.vector_in_files(doc_id, pin)
    }

    pub(crate) fn current_vector(&self, doc_id: &str) -> Result<Option<Vec<f32>>> {
        if let Some(vector) = self.held.get_vector(doc_id)? {
            return Ok(Some(vector));
        }
        self.vector_in_files(doc_id, i64::MAX)
    }

    fn vector_in_files(&self, doc_id: &str, pin: i64) -> Result<Option<Vec<f32>>> {
        let Some(number) = self.visible_number(doc_id, pin)? else {
            return Ok(None);
        };
        let mut vector = vec![0f32; self.field.dimension()];
        self.field.vector_into(number, &mut vector)?;
        Ok(Some(vector))
    }
}

pub(super) fn replay(shared: &Shared, writer: &mut Writer, writes: Vec<HeldWrite>) -> Result<()> {
    for write in writes {
        match write {
            HeldWrite::Insert {
                doc_id,
                vector,
                sequence,
            } => insert_stamped(shared, writer, &doc_id, &vector, sequence)?,
            HeldWrite::Remove { doc_id, sequence } => remove_stamped(writer, &doc_id, sequence)?,
        }
    }
    Ok(())
}
