use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::thread::{self, ThreadId};

use crate::error::{ErrorCode, NarsilError, Result};

/// The index names that a create, a drop, or a restore holds, so that two of them never change the same name at
/// once while calls on other names go ahead.
#[derive(Default)]
pub(crate) struct NameTurns {
    held: Mutex<HashMap<String, ThreadId>>,
    released: Condvar,
}

/// One held name, which goes back to the engine when this value drops.
pub(crate) struct NameTurn<'a> {
    turns: &'a NameTurns,
    name: String,
}

fn guarded(held: &Mutex<HashMap<String, ThreadId>>) -> MutexGuard<'_, HashMap<String, ThreadId>> {
    held.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn held_by_this_thread(name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        format!(
            "A listener or plugin hook asked for index \"{name}\" while the call that runs it holds that index, so the engine refuses the call instead of waiting for itself"
        ),
    )
}

impl NameTurns {
    /// Waits until no other call holds `name`, then holds it, and fails with `CONFIG_INVALID` where the calling
    /// thread holds `name` already, as a listener or plugin hook of the call that holds it does.
    pub(crate) fn take(&self, name: &str) -> Result<NameTurn<'_>> {
        let caller = thread::current().id();
        let mut held = guarded(&self.held);
        while let Some(holder) = held.get(name) {
            if *holder == caller {
                return Err(held_by_this_thread(name));
            }
            held = self
                .released
                .wait(held)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        held.insert(name.to_string(), caller);
        Ok(NameTurn {
            turns: self,
            name: name.to_string(),
        })
    }

    /// Fails with `CONFIG_INVALID` where the calling thread holds `name`, as [`NameTurns::take`] would, so that a
    /// caller can refuse before it changes anything else.
    pub(crate) fn refuse_held_by_this_thread(&self, name: &str) -> Result<()> {
        let caller = thread::current().id();
        match guarded(&self.held).get(name) {
            Some(holder) if *holder == caller => Err(held_by_this_thread(name)),
            _ => Ok(()),
        }
    }

    /// Holds `name` where no call holds it, and otherwise returns `None` at once.
    pub(crate) fn try_take(&self, name: &str) -> Option<NameTurn<'_>> {
        let mut held = guarded(&self.held);
        if held.contains_key(name) {
            return None;
        }
        held.insert(name.to_string(), thread::current().id());
        Some(NameTurn {
            turns: self,
            name: name.to_string(),
        })
    }
}

impl Drop for NameTurn<'_> {
    fn drop(&mut self) {
        guarded(&self.turns.held).remove(&self.name);
        self.turns.released.notify_all();
    }
}
