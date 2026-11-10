use std::collections::HashSet;
use std::sync::{Condvar, Mutex, MutexGuard};

/// The index names that a create, a drop, or a restore holds, so that two of them never change the same name at
/// once while calls on other names go ahead.
#[derive(Default)]
pub(crate) struct NameTurns {
    held: Mutex<HashSet<String>>,
    released: Condvar,
}

/// One held name, which goes back to the engine when this value drops.
pub(crate) struct NameTurn<'a> {
    turns: &'a NameTurns,
    name: String,
}

fn guarded(held: &Mutex<HashSet<String>>) -> MutexGuard<'_, HashSet<String>> {
    held.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl NameTurns {
    /// Waits until no other call holds `name`, then holds it.
    pub(crate) fn take(&self, name: &str) -> NameTurn<'_> {
        let mut held = guarded(&self.held);
        while held.contains(name) {
            held = self
                .released
                .wait(held)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        held.insert(name.to_string());
        NameTurn {
            turns: self,
            name: name.to_string(),
        }
    }

    /// Holds `name` where no other call holds it, and otherwise returns `None` at once.
    pub(crate) fn try_take(&self, name: &str) -> Option<NameTurn<'_>> {
        let mut held = guarded(&self.held);
        if !held.insert(name.to_string()) {
            return None;
        }
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
