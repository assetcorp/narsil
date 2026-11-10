use std::ptr;
use std::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};

struct Node<T> {
    value: T,
    next: *mut Node<T>,
}

pub(crate) struct Published<T> {
    head: AtomicPtr<Node<T>>,
    count: AtomicUsize,
}

unsafe impl<T: Send + Sync> Send for Published<T> {}
unsafe impl<T: Send + Sync> Sync for Published<T> {}

impl<T> Default for Published<T> {
    fn default() -> Published<T> {
        Published {
            head: AtomicPtr::new(ptr::null_mut()),
            count: AtomicUsize::new(0),
        }
    }
}

struct Entries<'a, T> {
    at: *mut Node<T>,
    list: std::marker::PhantomData<&'a Published<T>>,
}

impl<'a, T> Iterator for Entries<'a, T> {
    type Item = &'a T;

    fn next(&mut self) -> Option<&'a T> {
        let node = unsafe { self.at.as_ref()? };
        self.at = node.next;
        Some(&node.value)
    }
}

impl<T> Published<T> {
    fn entries_from(&self, head: *mut Node<T>) -> Entries<'_, T> {
        Entries {
            at: head,
            list: std::marker::PhantomData,
        }
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = &T> {
        self.entries_from(self.head.load(Ordering::Acquire))
    }

    pub(crate) fn find(&self, matches: impl Fn(&T) -> bool) -> Option<&T> {
        self.iter().find(|value| matches(value))
    }

    pub(crate) fn publish(
        &self,
        value: T,
        matches: impl Fn(&T) -> bool,
        limit: usize,
    ) -> Result<&T, T> {
        let mut value = value;
        loop {
            let head = self.head.load(Ordering::Acquire);
            if let Some(held) = self.entries_from(head).find(|held| matches(held)) {
                return Ok(held);
            }
            if self.count.load(Ordering::Acquire) >= limit {
                return Err(value);
            }
            let node = Box::into_raw(Box::new(Node { value, next: head }));
            match self
                .head
                .compare_exchange(head, node, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => {
                    self.count.fetch_add(1, Ordering::AcqRel);
                    return Ok(unsafe { &(*node).value });
                }
                Err(_) => value = unsafe { Box::from_raw(node) }.value,
            }
        }
    }

    pub(crate) fn push_held(&mut self, value: T) {
        let next = *self.head.get_mut();
        *self.head.get_mut() = Box::into_raw(Box::new(Node { value, next }));
        *self.count.get_mut() += 1;
    }

    pub(crate) fn try_for_each_held<E>(
        &mut self,
        mut visit: impl FnMut(&mut T) -> Result<(), E>,
    ) -> Result<(), E> {
        let mut at = *self.head.get_mut();
        while let Some(node) = unsafe { at.as_mut() } {
            visit(&mut node.value)?;
            at = node.next;
        }
        Ok(())
    }
}

impl<T: Clone> Clone for Published<T> {
    fn clone(&self) -> Published<T> {
        let held: Vec<&T> = self.iter().collect();
        let mut copy = Published::default();
        for value in held.into_iter().rev() {
            copy.push_held(value.clone());
        }
        copy
    }
}

impl<T> Drop for Published<T> {
    fn drop(&mut self) {
        let mut at = *self.head.get_mut();
        while !at.is_null() {
            let node = unsafe { Box::from_raw(at) };
            at = node.next;
        }
    }
}
