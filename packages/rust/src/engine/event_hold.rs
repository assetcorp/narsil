use std::cell::RefCell;
use std::marker::PhantomData;
use std::panic::{AssertUnwindSafe, catch_unwind};

use super::callback_scope::CallbackScope;
use super::events::{Listener, NarsilEvent};

struct HeldEvent {
    dispatcher: usize,
    listeners: Vec<Listener>,
    event: NarsilEvent,
}

struct HeldEvents {
    holds: usize,
    queued: Vec<HeldEvent>,
}

thread_local! {
    static HELD_EVENTS: RefCell<HeldEvents> = const {
        RefCell::new(HeldEvents {
            holds: 0,
            queued: Vec::new(),
        })
    };
}

pub(crate) struct EventHold {
    _stays_on_its_thread: PhantomData<*const ()>,
}

pub(crate) fn hold_events() -> EventHold {
    let _ = HELD_EVENTS.try_with(|held| held.borrow_mut().holds += 1);
    EventHold {
        _stays_on_its_thread: PhantomData,
    }
}

pub(crate) fn deliver(dispatcher: usize, listeners: &[Listener], event: &NarsilEvent) {
    let _scope = CallbackScope::enter_at(dispatcher);
    for listener in listeners {
        let _ = catch_unwind(AssertUnwindSafe(|| listener(event)));
    }
}

pub(crate) fn queue_while_held(
    dispatcher: usize,
    listeners: Vec<Listener>,
    event: NarsilEvent,
) -> Option<(Vec<Listener>, NarsilEvent)> {
    let mut unheld = Some((listeners, event));
    let _ = HELD_EVENTS.try_with(|held| {
        let mut held = held.borrow_mut();
        if held.holds > 0
            && let Some((listeners, event)) = unheld.take()
        {
            held.queued.push(HeldEvent {
                dispatcher,
                listeners,
                event,
            });
        }
    });
    unheld
}

impl Drop for EventHold {
    fn drop(&mut self) {
        let released = HELD_EVENTS
            .try_with(|held| {
                let mut held = held.borrow_mut();
                held.holds = held.holds.saturating_sub(1);
                if held.holds == 0 {
                    std::mem::take(&mut held.queued)
                } else {
                    Vec::new()
                }
            })
            .unwrap_or_default();
        if std::thread::panicking() {
            return;
        }
        for held in released {
            deliver(held.dispatcher, &held.listeners, &held.event);
        }
    }
}
