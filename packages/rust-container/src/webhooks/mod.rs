mod constants;
mod deferred;
mod delivery;
mod queue;
mod reports;
mod send;
mod store;

use std::collections::BTreeSet;
use std::sync::Arc;

use tokio::runtime::Handle;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::sync::oneshot;

use crate::events::Output;
use queue::{Command, Queue, QueueConfig};
use reports::QueueReports;

pub use send::Destination;
pub use store::DeliveryStore;

#[derive(Clone)]
pub struct QueueHandle {
    commands: UnboundedSender<Command>,
    store: DeliveryStore,
}

pub struct QueueParts {
    pub destination: Destination,
    pub events: Option<BTreeSet<String>>,
    pub store: DeliveryStore,
    pub output: Output,
}

impl QueueHandle {
    pub fn spawn(runtime: &Handle, parts: QueueParts) -> QueueHandle {
        let (commands, receiver) = unbounded_channel();
        let config = QueueConfig {
            destination: Arc::new(parts.destination),
            events: parts.events,
            store: parts.store.clone(),
            reports: QueueReports::new(parts.output),
        };
        let queue = Queue::new(config, commands.clone());
        runtime.spawn(queue.run(receiver));
        QueueHandle {
            commands,
            store: parts.store,
        }
    }

    pub fn enqueue(&self, event_type: String, body: String) {
        let _ = self.commands.send(Command::Enqueue { event_type, body });
    }

    pub async fn start(&self) {
        let loaded = self.store.load().await;
        let _ = self.commands.send(Command::Start(loaded));
    }

    pub async fn close(&self) {
        let (done, closed) = oneshot::channel();
        if self.commands.send(Command::Close(done)).is_err() {
            return;
        }
        let _ = closed.await;
    }
}
