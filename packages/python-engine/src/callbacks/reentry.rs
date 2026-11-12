use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

use narsil::NarsilError;

use crate::errors::config_invalid;

static NEXT_ENGINE_MARK: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct EngineMark(u64);

impl EngineMark {
    pub(crate) fn fresh() -> EngineMark {
        EngineMark(NEXT_ENGINE_MARK.fetch_add(1, Ordering::Relaxed))
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Reentry {
    Allowed,
    Refused(EngineMark),
}

thread_local! {
    static AWAITED: RefCell<Vec<(EngineMark, String)>> = const { RefCell::new(Vec::new()) };
}

pub(crate) struct Awaited {
    marked: bool,
}

impl Drop for Awaited {
    fn drop(&mut self) {
        if self.marked {
            AWAITED.with_borrow_mut(|awaited| awaited.pop());
        }
    }
}

pub(crate) fn awaited(reentry: Reentry, subject: &str) -> Awaited {
    let Reentry::Refused(mark) = reentry else {
        return Awaited { marked: false };
    };
    AWAITED.with_borrow_mut(|awaited| awaited.push((mark, subject.to_string())));
    Awaited { marked: true }
}

pub(crate) fn refuse_reentry(mark: EngineMark) -> Result<(), NarsilError> {
    let caller = AWAITED.with_borrow(|awaited| {
        awaited
            .iter()
            .rev()
            .find(|(awaited_mark, _)| *awaited_mark == mark)
            .map(|(_, subject)| subject.clone())
    });
    match caller {
        Some(subject) => Err(config_invalid(format!(
            "{subject} called the engine that is waiting for it to return, so the engine refuses the call; call the engine after the callback returns, or call another engine"
        ))),
        None => Ok(()),
    }
}
