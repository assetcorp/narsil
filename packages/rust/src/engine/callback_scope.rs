use std::cell::RefCell;

thread_local! {
    static DISPATCHERS_ON_STACK: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
}

pub(crate) struct CallbackScope {
    dispatcher: usize,
}

impl CallbackScope {
    pub(crate) fn enter<T>(dispatcher: &T) -> CallbackScope {
        let dispatcher = std::ptr::from_ref(dispatcher).addr();
        let _ = DISPATCHERS_ON_STACK.try_with(|held| held.borrow_mut().push(dispatcher));
        CallbackScope { dispatcher }
    }
}

impl Drop for CallbackScope {
    fn drop(&mut self) {
        let _ = DISPATCHERS_ON_STACK.try_with(|held| {
            let mut held = held.borrow_mut();
            if let Some(at) = held.iter().rposition(|entry| *entry == self.dispatcher) {
                held.remove(at);
            }
        });
    }
}

pub(crate) fn dispatching_on_current_thread<T>(dispatcher: &T) -> bool {
    let dispatcher = std::ptr::from_ref(dispatcher).addr();
    DISPATCHERS_ON_STACK
        .try_with(|held| held.borrow().contains(&dispatcher))
        .unwrap_or(false)
}
