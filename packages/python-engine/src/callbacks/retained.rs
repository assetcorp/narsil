use std::cell::RefCell;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use pyo3::exceptions::PyRuntimeError;
use pyo3::gc::{PyTraverseError, PyVisit};
use pyo3::prelude::*;

use super::reentry::{EngineMark, Reentry};

const RELEASED_MESSAGE: &str = "The engine has shut down and released this Python object";

struct Slot {
    object: Mutex<Option<Py<PyAny>>>,
    engine: Option<EngineMark>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Collected {
    engine: EngineMark,
    slots: Vec<Arc<Slot>>,
}

thread_local! {
    static COLLECTING: RefCell<Option<Collected>> = const { RefCell::new(None) };
}

#[derive(Clone)]
pub(crate) struct Retained(Arc<Slot>);

impl Retained {
    pub(crate) fn new(object: &Bound<'_, PyAny>) -> Retained {
        COLLECTING.with_borrow_mut(|collecting| {
            let slot = Arc::new(Slot {
                object: Mutex::new(Some(object.clone().unbind())),
                engine: collecting.as_ref().map(|collected| collected.engine),
            });
            if let Some(collected) = collecting {
                collected.slots.push(Arc::clone(&slot));
            }
            Retained(slot)
        })
    }

    pub(crate) fn engine(&self) -> Option<EngineMark> {
        self.0.engine
    }

    pub(crate) fn awaited_by_engine(&self) -> Reentry {
        match self.0.engine {
            Some(mark) => Reentry::Refused(mark),
            None => Reentry::Allowed,
        }
    }

    pub(crate) fn bind<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        locked(&self.0.object)
            .as_ref()
            .map(|object| object.bind(py).clone())
            .ok_or_else(|| PyRuntimeError::new_err(RELEASED_MESSAGE))
    }
}

pub(crate) struct RetainedSet {
    engine: EngineMark,
    slots: Mutex<Vec<Weak<Slot>>>,
}

struct Collecting<'set> {
    set: &'set RetainedSet,
    outer: Option<Collected>,
}

impl Drop for Collecting<'_> {
    fn drop(&mut self) {
        let outer = self.outer.take();
        let collected = COLLECTING
            .with_borrow_mut(|collecting| std::mem::replace(collecting, outer))
            .map(|collected| collected.slots)
            .unwrap_or_default();
        self.set.keep(collected);
    }
}

impl RetainedSet {
    pub(crate) fn new() -> RetainedSet {
        RetainedSet {
            engine: EngineMark::fresh(),
            slots: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn engine(&self) -> EngineMark {
        self.engine
    }

    pub(crate) fn collect<T>(&self, convert: impl FnOnce() -> T) -> T {
        let outer = COLLECTING.with_borrow_mut(|collecting| {
            collecting.replace(Collected {
                engine: self.engine,
                slots: Vec::new(),
            })
        });
        let _collecting = Collecting { set: self, outer };
        convert()
    }

    fn keep(&self, collected: Vec<Arc<Slot>>) {
        {
            let mut slots = locked(&self.slots);
            slots.retain(|slot| slot.strong_count() > 0);
            slots.extend(collected.iter().map(Arc::downgrade));
        }
        drop(collected);
    }

    pub(crate) fn traverse(&self, visit: &PyVisit<'_>) -> Result<(), PyTraverseError> {
        let Ok(slots) = self.slots.try_lock() else {
            return Ok(());
        };
        for slot in slots.iter().filter_map(Weak::upgrade) {
            if let Ok(object) = slot.object.try_lock() {
                visit.call(object.as_ref())?;
            }
        }
        Ok(())
    }

    pub(crate) fn release(&self) {
        let slots: Vec<Arc<Slot>> = std::mem::take(&mut *locked(&self.slots))
            .iter()
            .filter_map(Weak::upgrade)
            .collect();
        let objects: Vec<Py<PyAny>> = slots
            .iter()
            .filter_map(|slot| locked(&slot.object).take())
            .collect();
        drop(slots);
        drop(objects);
    }
}
