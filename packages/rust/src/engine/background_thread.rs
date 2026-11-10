use std::io;
use std::sync::Mutex;
use std::thread::JoinHandle;

#[derive(Default)]
pub(crate) struct BackgroundThread {
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl BackgroundThread {
    pub(crate) fn hold(&self, spawned: io::Result<JoinHandle<()>>) {
        if let (Ok(handle), Ok(mut held)) = (spawned, self.handle.lock()) {
            *held = Some(handle);
        }
    }

    pub(crate) fn join(&self) {
        let handle = self.handle.lock().ok().and_then(|mut held| held.take());
        if let Some(handle) = handle
            && handle.thread().id() != std::thread::current().id()
        {
            let _ = handle.join();
        }
    }
}
