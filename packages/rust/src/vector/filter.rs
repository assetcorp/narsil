use super::field::Generation;

#[derive(Debug, Clone, Default)]
pub(crate) struct OrdinalFilter {
    bits: Vec<u8>,
    ordinals: Vec<u32>,
}

impl OrdinalFilter {
    pub(crate) fn count(&self) -> u64 {
        self.ordinals.len() as u64
    }

    pub(crate) fn has(&self, ordinal: u32) -> bool {
        self.bits
            .get(ordinal as usize / 8)
            .is_some_and(|byte| byte & (1 << (ordinal % 8)) != 0)
    }

    pub(crate) fn bits(&self) -> &[u8] {
        &self.bits
    }

    pub(crate) fn ordinals(&self) -> &[u32] {
        &self.ordinals
    }

    fn admit(&mut self, ordinal: u32) {
        let at = ordinal as usize / 8;
        if at >= self.bits.len() {
            self.bits.resize(at + 1, 0);
        }
        let bit = 1 << (ordinal % 8);
        if self.bits[at] & bit == 0 {
            self.bits[at] |= bit;
            self.ordinals.push(ordinal);
        }
    }
}

impl Generation {
    pub(crate) fn pinned_ordinal_of(&self, doc_id: &str, pin: i64) -> Option<u32> {
        let mut ordinal = self.ordinal_of(doc_id)?;
        while self.store.born_at(ordinal) > pin {
            ordinal = self.store.earlier_ordinal(ordinal)?;
        }
        Some(ordinal)
    }

    pub(crate) fn filter_of<'a>(
        &self,
        doc_ids: impl IntoIterator<Item = &'a str>,
        pin: i64,
    ) -> OrdinalFilter {
        let mut filter = OrdinalFilter {
            bits: vec![0; (self.store.slots() as usize).div_ceil(8)],
            ordinals: Vec::new(),
        };
        for doc_id in doc_ids {
            if let Some(ordinal) = self.pinned_ordinal_of(doc_id, pin) {
                filter.admit(ordinal);
            }
        }
        filter.ordinals.sort_unstable();
        filter
    }
}
