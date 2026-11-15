use std::sync::atomic::AtomicU32;

use super::doc_ids::IdTable;
use super::field::VectorField;

impl VectorField {
    pub(crate) fn growth_bytes(&self, added: usize) -> usize {
        if added == 0 {
            return 0;
        }
        let writer = self.shared.lock_writer();
        let generation = &writer.generation;
        let mut bytes = generation.store.growth_bytes(added);
        let used = writer.id_slots_used.saturating_add(added);
        if !generation.ids.fits(used) {
            bytes = bytes.saturating_add(IdTable::bytes_for_entries(used.saturating_mul(2) + 1));
        }
        let buffered = generation.buffer.len().saturating_add(added);
        if buffered >= generation.buffer_capacity() {
            bytes = bytes.saturating_add((buffered + 1) * 2 * size_of::<AtomicU32>());
        }
        bytes
    }
}
