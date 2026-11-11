use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard};
use std::thread::{self, ThreadId};

#[derive(Default)]
pub(crate) struct ShutdownGate {
    publications: RwLock<()>,
    running: Mutex<Option<ThreadId>>,
    finished: Condvar,
}

pub(crate) struct ShutdownTurn<'gate> {
    gate: &'gate ShutdownGate,
}

impl Drop for ShutdownTurn<'_> {
    fn drop(&mut self) {
        *self.gate.running() = None;
        self.gate.finished.notify_all();
    }
}

impl ShutdownGate {
    fn running(&self) -> MutexGuard<'_, Option<ThreadId>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn admit(&self) -> RwLockReadGuard<'_, ()> {
        self.publications
            .read()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn await_admitted(&self) {
        drop(
            self.publications
                .write()
                .unwrap_or_else(PoisonError::into_inner),
        );
    }

    pub(crate) fn turn(
        &self,
        shut_down: &AtomicBool,
        inside_callback: bool,
    ) -> Option<ShutdownTurn<'_>> {
        let caller = thread::current().id();
        let mut running = self.running();
        loop {
            match *running {
                Some(holder) if holder == caller => return None,
                Some(_) if inside_callback => return None,
                Some(_) => {
                    running = self
                        .finished
                        .wait(running)
                        .unwrap_or_else(PoisonError::into_inner);
                }
                None => break,
            }
        }
        if shut_down.load(Ordering::Acquire) {
            return None;
        }
        *running = Some(caller);
        Some(ShutdownTurn { gate: self })
    }
}
