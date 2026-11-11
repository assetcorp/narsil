use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, ThreadId};

use crate::error::{ErrorCode, NarsilError};

pub(crate) fn shut_down_before_publication() -> NarsilError {
    NarsilError::new(
        ErrorCode::INSTANCE_SHUT_DOWN,
        "This Narsil instance shut down before the index could join it",
    )
}

#[derive(Default)]
struct Publications {
    admitting_threads: Vec<ThreadId>,
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
    admitting_thread: ThreadId,
    held_on_admitting_thread: PhantomData<*const ()>,
}

impl Drop for Admission<'_> {
    fn drop(&mut self) {
        let mut publications = self.gate.publications();
        let admitting = &mut publications.admitting_threads;
        if let Some(at) = admitting
            .iter()
            .rposition(|thread| *thread == self.admitting_thread)
        {
            admitting.swap_remove(at);
        }
        if admitting.is_empty() {
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
        let admitting_thread = thread::current().id();
        let mut publications = self.publications();
        if publications.closed {
            return None;
        }
        publications.admitting_threads.push(admitting_thread);
        Some(Admission {
            gate: self,
            admitting_thread,
            held_on_admitting_thread: PhantomData,
        })
    }

    pub(crate) fn admitted_on_current_thread(&self) -> bool {
        let caller = thread::current().id();
        self.publications().admitting_threads.contains(&caller)
    }

    pub(crate) fn await_admitted(&self) {
        let mut publications = self.publications();
        publications.closed = true;
        while !publications.admitting_threads.is_empty() {
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
