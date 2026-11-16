use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use narsil::PersistenceAdapter;
use tokio::task::JoinHandle;

use super::constants::DELIVERY_LOAD_CONCURRENCY;
use super::delivery::{Delivery, is_delivery_key, key_of};
use crate::storage::RecordFolder;

type Chains = Arc<Mutex<HashMap<String, (u64, JoinHandle<()>)>>>;

enum KeyWrite {
    Save(Vec<u8>),
    Remove,
}

#[derive(Clone)]
pub struct DeliveryStore {
    folder: Option<Arc<RecordFolder>>,
    chains: Chains,
    next_write: Arc<Mutex<u64>>,
}

enum Loaded {
    Delivery(Box<Delivery>),
    Unreadable(String),
    Skipped,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn load_key(folder: &RecordFolder, key: &str) -> Loaded {
    if !is_delivery_key(key) {
        return Loaded::Unreadable(key.to_string());
    }
    match folder.load(key) {
        Err(_) => Loaded::Skipped,
        Ok(None) => Loaded::Unreadable(key.to_string()),
        Ok(Some(bytes)) => match Delivery::parse(key, &bytes) {
            Some(delivery) => Loaded::Delivery(Box::new(delivery)),
            None => Loaded::Unreadable(key.to_string()),
        },
    }
}

fn load_all(folder: &RecordFolder) -> Vec<Delivery> {
    let Ok(keys) = folder.list("") else {
        return Vec::new();
    };
    let threads = DELIVERY_LOAD_CONCURRENCY.min(keys.len()).max(1);
    let share = keys.len().div_ceil(threads).max(1);
    let outcomes: Vec<Loaded> = std::thread::scope(|scope| {
        let readers: Vec<_> = keys
            .chunks(share)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|key| load_key(folder, key))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        readers
            .into_iter()
            .flat_map(|reader| reader.join().unwrap_or_default())
            .collect()
    });
    let mut deliveries = Vec::new();
    for outcome in outcomes {
        match outcome {
            Loaded::Delivery(delivery) => deliveries.push(*delivery),
            Loaded::Unreadable(key) => {
                let _ = folder.delete(&key);
            }
            Loaded::Skipped => {}
        }
    }
    deliveries
}

impl DeliveryStore {
    pub fn memory() -> DeliveryStore {
        DeliveryStore {
            folder: None,
            chains: Arc::default(),
            next_write: Arc::default(),
        }
    }

    pub fn persisted(folder: RecordFolder) -> DeliveryStore {
        DeliveryStore {
            folder: Some(Arc::new(folder)),
            ..DeliveryStore::memory()
        }
    }

    pub async fn load(&self) -> Vec<Delivery> {
        let Some(folder) = self.folder.clone() else {
            return Vec::new();
        };
        tokio::task::spawn_blocking(move || load_all(&folder))
            .await
            .unwrap_or_default()
    }

    pub fn save(&self, delivery: &Delivery, done: impl FnOnce(bool) + Send + 'static) {
        self.chain(&delivery.id, KeyWrite::Save(delivery.to_bytes()), done);
    }

    pub fn remove(&self, id: &str, done: impl FnOnce(bool) + Send + 'static) {
        self.chain(id, KeyWrite::Remove, done);
    }

    fn chain(&self, id: &str, write: KeyWrite, done: impl FnOnce(bool) + Send + 'static) {
        let Some(folder) = self.folder.clone() else {
            done(true);
            return;
        };
        let generation = {
            let mut next = lock(&self.next_write);
            *next += 1;
            *next
        };
        let key = key_of(id);
        let chains = Arc::clone(&self.chains);
        let owner = id.to_string();
        let mut held = lock(&self.chains);
        let previous = held.remove(id).map(|(_, handle)| handle);
        let handle = tokio::spawn(async move {
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            let written = tokio::task::spawn_blocking(move || match write {
                KeyWrite::Save(bytes) => folder.save(&key, &bytes).is_ok(),
                KeyWrite::Remove => folder.delete(&key).is_ok(),
            })
            .await
            .unwrap_or(false);
            {
                let mut held = lock(&chains);
                if held
                    .get(&owner)
                    .is_some_and(|(latest, _)| *latest == generation)
                {
                    held.remove(&owner);
                }
            }
            done(written);
        });
        held.insert(id.to_string(), (generation, handle));
    }

    pub async fn flush(&self) {
        loop {
            let pending: Vec<JoinHandle<()>> = lock(&self.chains)
                .drain()
                .map(|(_, (_, handle))| handle)
                .collect();
            if pending.is_empty() {
                return;
            }
            for handle in pending {
                let _ = handle.await;
            }
        }
    }
}
