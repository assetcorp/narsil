use std::sync::atomic::{AtomicU64, Ordering, fence};

use super::constants::DOCUMENT_WRITE_STRIPES;
use crate::util::hash::fnv1a;

/// One sequence number for each stripe of document IDs, odd while a write changes a document of that stripe, so
/// that a read of a document and its vectors can tell whether a write overlapped it.
pub(crate) struct DocumentWrites {
    stripes: Box<[AtomicU64]>,
}

/// Keeps the stripe of one document odd until it drops, which a write holds while it changes that document's
/// vectors and its partition.
pub(crate) struct DocumentWrite<'a> {
    stripe: &'a AtomicU64,
}

impl Default for DocumentWrites {
    fn default() -> DocumentWrites {
        DocumentWrites {
            stripes: (0..DOCUMENT_WRITE_STRIPES)
                .map(|_| AtomicU64::new(0))
                .collect(),
        }
    }
}

impl DocumentWrites {
    fn stripe(&self, id: &str) -> &AtomicU64 {
        &self.stripes[fnv1a(id.as_bytes()) as usize % self.stripes.len()]
    }

    /// Marks the document under `id` as changing until the returned guard drops, waiting while another write
    /// marks a document of the same stripe.
    pub(crate) fn begin(&self, id: &str) -> DocumentWrite<'_> {
        let stripe = self.stripe(id);
        let mut seen = stripe.load(Ordering::Relaxed);
        loop {
            if seen & 1 == 1 {
                std::hint::spin_loop();
                seen = stripe.load(Ordering::Relaxed);
                continue;
            }
            match stripe.compare_exchange_weak(seen, seen + 1, Ordering::Acquire, Ordering::Relaxed) {
                Ok(_) => break,
                Err(now) => seen = now,
            }
        }
        fence(Ordering::Release);
        DocumentWrite { stripe }
    }

    /// Returns the sequence of the stripe of `id` where no write is changing a document of that stripe, which
    /// [`DocumentWrites::unchanged_since`] takes once the read finishes.
    pub(crate) fn read_begin(&self, id: &str) -> Option<u64> {
        let seen = self.stripe(id).load(Ordering::Acquire);
        (seen & 1 == 0).then_some(seen)
    }

    /// Reports whether no write changed a document of the stripe of `id` since [`DocumentWrites::read_begin`]
    /// returned `seen`.
    pub(crate) fn unchanged_since(&self, id: &str, seen: u64) -> bool {
        fence(Ordering::Acquire);
        self.stripe(id).load(Ordering::Relaxed) == seen
    }
}

impl Drop for DocumentWrite<'_> {
    fn drop(&mut self) {
        self.stripe.fetch_add(1, Ordering::Release);
    }
}
