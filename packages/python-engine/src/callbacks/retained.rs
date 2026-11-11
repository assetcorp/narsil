use std::cell::RefCell;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use pyo3::exceptions::PyRuntimeError;
use pyo3::gc::{PyTraverseError, PyVisit};
use pyo3::prelude::*;

const RELEASED_MESSAGE: &str = "The engine has shut down and released this Python object";

struct Slot {
    object: Mutex<Option<Py<PyAny>>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

thread_local! {
    static COLLECTING: RefCell<Option<Vec<Arc<Slot>>>> = const { RefCell::new(None) };
}

#[derive(Clone)]
pub(crate) struct Retained(Arc<Slot>);

impl Retained {
    pub(crate) fn new(object: &Bound<'_, PyAny>) -> Retained {
        let slot = Arc::new(Slot {
            object: Mutex::new(Some(object.clone().unbind())),
        });
        COLLECTING.with_borrow_mut(|collected| {
            if let Some(collected) = collected {
                collected.push(Arc::clone(&slot));
            }
        });
        Retained(slot)
    }

    pub(crate) fn bind<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        locked(&self.0.object)
            .as_ref()
            .map(|object| object.bind(py).clone())
            .ok_or_else(|| PyRuntimeError::new_err(RELEASED_MESSAGE))
    }
}

#[derive(Default)]
pub(crate) struct RetainedSet {
    slots: Mutex<Vec<Arc<Slot>>>,
}

struct Collecting<'set> {
    set: &'set RetainedSet,
    outer: Option<Vec<Arc<Slot>>>,
}

impl Drop for Collecting<'_> {
    fn drop(&mut self) {
        let outer = self.outer.take();
        let collected = COLLECTING
            .with_borrow_mut(|collecting| std::mem::replace(collecting, outer))
            .unwrap_or_default();
        self.set.keep(collected);
    }
}

impl RetainedSet {
    pub(crate) fn collect<T>(&self, convert: impl FnOnce() -> T) -> T {
        let outer = COLLECTING.with_borrow_mut(|collecting| collecting.replace(Vec::new()));
        let _collecting = Collecting { set: self, outer };
        convert()
    }

    fn keep(&self, collected: Vec<Arc<Slot>>) {
        let unused: Vec<Arc<Slot>> = {
            let mut slots = locked(&self.slots);
            let (shared, unused) = slots
                .drain(..)
                .partition(|slot| Arc::strong_count(slot) > 1);
            *slots = shared;
            slots.extend(collected);
            unused
        };
        drop(unused);
    }

    pub(crate) fn prune(&self) {
        self.keep(Vec::new());
    }

    pub(crate) fn traverse(&self, visit: &PyVisit<'_>) -> Result<(), PyTraverseError> {
        let Ok(slots) = self.slots.try_lock() else {
            return Ok(());
        };
        for slot in slots.iter() {
            if let Ok(object) = slot.object.try_lock() {
                visit.call(object.as_ref())?;
            }
        }
        Ok(())
    }

    pub(crate) fn release(&self) {
        let slots = std::mem::take(&mut *locked(&self.slots));
        let objects: Vec<Py<PyAny>> = slots
            .iter()
            .filter_map(|slot| locked(&slot.object).take())
            .collect();
        drop(slots);
        drop(objects);
    }
}
