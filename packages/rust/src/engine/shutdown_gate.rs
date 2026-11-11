use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, ThreadId};

#[derive(Default)]
struct Publications {
    admitted: usize,
    closed: bool,
}

#[derive(Default)]
pub(crate) struct ShutdownGate {
    publications: Mutex<Publications>,
    published: Condvar,
    running: Mutex<Option<ThreadId>>,
    finished: Condvar,
}

pub(crate) struct Admission<'gate> {
    gate: &'gate ShutdownGate,
}

impl Drop for Admission<'_> {
    fn drop(&mut self) {
        let mut publications = self.gate.publications();
        publications.admitted = publications.admitted.saturating_sub(1);
        if publications.admitted == 0 {
            self.gate.published.notify_all();
        }
    }
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

    fn publications(&self) -> MutexGuard<'_, Publications> {
        self.publications
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn admit(&self) -> Option<Admission<'_>> {
        let mut publications = self.publications();
        if publications.closed {
            return None;
        }
        publications.admitted += 1;
        Some(Admission { gate: self })
    }

    pub(crate) fn await_admitted(&self) {
        let mut publications = self.publications();
        publications.closed = true;
        while publications.admitted > 0 {
            publications = self
                .published
                .wait(publications)
                .unwrap_or_else(PoisonError::into_inner);
        }
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
