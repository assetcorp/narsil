use tokio::sync::watch;

pub(crate) struct RequestsInFlight {
    count: watch::Sender<usize>,
}

pub(crate) struct InFlight {
    count: watch::Sender<usize>,
}

impl RequestsInFlight {
    pub(crate) fn new() -> RequestsInFlight {
        RequestsInFlight {
            count: watch::Sender::new(0),
        }
    }

    pub(crate) fn enter(&self) -> InFlight {
        self.count.send_modify(|count| *count += 1);
        InFlight {
            count: self.count.clone(),
        }
    }

    pub(crate) async fn settled(&self) {
        let mut count = self.count.subscribe();
        let _ = count.wait_for(|count| *count == 0).await;
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.count
            .send_modify(|count| *count = count.saturating_sub(1));
    }
}
