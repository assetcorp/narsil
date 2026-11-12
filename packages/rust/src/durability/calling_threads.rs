use std::marker::PhantomData;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread::{self, ThreadId};

#[derive(Default)]
pub(crate) struct CallingThreads {
    threads: Mutex<Vec<ThreadId>>,
}

pub(crate) struct Call<'calls> {
    calls: &'calls CallingThreads,
    thread: ThreadId,
    held_on_calling_thread: PhantomData<*const ()>,
}

impl Drop for Call<'_> {
    fn drop(&mut self) {
        let mut threads = self.calls.threads();
        if let Some(at) = threads.iter().rposition(|thread| *thread == self.thread) {
            threads.swap_remove(at);
        }
    }
}

impl CallingThreads {
    fn threads(&self) -> MutexGuard<'_, Vec<ThreadId>> {
        self.threads.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn enter(&self) -> Call<'_> {
        let thread = thread::current().id();
        self.threads().push(thread);
        Call {
            calls: self,
            thread,
            held_on_calling_thread: PhantomData,
        }
    }

    pub(crate) fn on_current_thread(&self) -> bool {
        let caller = thread::current().id();
        self.threads().contains(&caller)
    }
}
