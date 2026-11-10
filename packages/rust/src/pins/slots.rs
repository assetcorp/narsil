use std::cell::RefCell;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, Weak};

use crate::error::{ErrorCode, NarsilError, Result};

use super::PinTable;
use super::constants::{MAX_THREAD_SLOTS, NO_PIN};

struct SlotPool {
    free: Vec<u32>,
    next: u32,
}

static POOL: Mutex<SlotPool> = Mutex::new(SlotPool {
    free: Vec::new(),
    next: 0,
});

static SLOTS_REACHED: AtomicU32 = AtomicU32::new(0);

struct HeldPins {
    table: Weak<PinTable>,
    address: usize,
    pins: Vec<i64>,
}

struct ThreadState {
    slot: u32,
    held: Vec<HeldPins>,
}

impl Drop for ThreadState {
    fn drop(&mut self) {
        for entry in &self.held {
            if let Some(table) = entry.table.upgrade() {
                table.store(self.slot, NO_PIN);
            }
        }
        let mut pool = POOL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        pool.free.push(self.slot);
    }
}

thread_local! {
    static THREAD: RefCell<Option<ThreadState>> = const { RefCell::new(None) };
}

fn too_many_threads() -> NarsilError {
    NarsilError::new(
        ErrorCode::WORKER_BUSY,
        format!(
            "Narsil serves at most {MAX_THREAD_SLOTS} threads at once, and every thread slot is in use"
        ),
    )
}

fn thread_gone() -> NarsilError {
    NarsilError::new(
        ErrorCode::INTERNAL_ERROR,
        "A thread called Narsil while the thread was ending",
    )
}

fn claimed_slot() -> Result<u32> {
    let mut pool = POOL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(slot) = pool.free.pop() {
        return Ok(slot);
    }
    if pool.next >= MAX_THREAD_SLOTS {
        return Err(too_many_threads());
    }
    let slot = pool.next;
    pool.next += 1;
    SLOTS_REACHED.fetch_max(slot + 1, Ordering::SeqCst);
    Ok(slot)
}

fn with_thread<T>(work: impl FnOnce(&mut ThreadState) -> T) -> Result<T> {
    THREAD
        .try_with(|cell| {
            let mut held = cell.try_borrow_mut().map_err(|_| thread_gone())?;
            if held.is_none() {
                *held = Some(ThreadState {
                    slot: claimed_slot()?,
                    held: Vec::new(),
                });
            }
            match held.as_mut() {
                Some(state) => Ok(work(state)),
                None => Err(thread_gone()),
            }
        })
        .map_err(|_| thread_gone())?
}

pub(crate) fn thread_slot() -> Result<u32> {
    with_thread(|state| state.slot)
}

pub(crate) fn slots_reached() -> u32 {
    SLOTS_REACHED.load(Ordering::SeqCst)
}

fn held_entry<'a>(state: &'a mut ThreadState, table: &Arc<PinTable>) -> &'a mut HeldPins {
    let address = Arc::as_ptr(table) as usize;
    state
        .held
        .retain(|entry| entry.address == address || entry.table.strong_count() > 0);
    let at = match state.held.iter().position(|entry| entry.address == address) {
        Some(at) => at,
        None => {
            state.held.push(HeldPins {
                table: Arc::downgrade(table),
                address,
                pins: Vec::new(),
            });
            state.held.len() - 1
        }
    };
    &mut state.held[at]
}

fn record_oldest(table: &PinTable, slot: u32, pins: &[i64]) {
    match pins.iter().min() {
        Some(&oldest) => table.store(slot, oldest + 1),
        None => table.store(slot, NO_PIN),
    }
}

pub(crate) fn take_pin(table: &Arc<PinTable>, sequence: &dyn Fn() -> i64) -> Result<i64> {
    with_thread(|state| {
        let slot = state.slot;
        let entry = held_entry(state, table);
        loop {
            let seen = sequence();
            if table.load(slot) == NO_PIN {
                table.store(slot, seen + 1);
            }
            if sequence() == seen {
                entry.pins.push(seen);
                record_oldest(table, slot, &entry.pins);
                return seen;
            }
        }
    })
}

pub(crate) fn release_pin(table: &Arc<PinTable>, pin: i64) {
    let _ = with_thread(|state| {
        let slot = state.slot;
        let entry = held_entry(state, table);
        if let Some(at) = entry.pins.iter().position(|&held| held == pin) {
            entry.pins.swap_remove(at);
        }
        record_oldest(table, slot, &entry.pins);
    });
}
