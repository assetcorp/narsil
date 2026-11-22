#![allow(dead_code)]

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use narsil::{Map, Value};
use narsil_cluster::error::ClusterError;
use narsil_cluster::node::WriteBatchResult;

use crate::data_node::{DataNode, eventually};
use crate::ledger::{LEDGER, title_of};

pub const BATCH_SIZE: usize = 200;
pub const ACKNOWLEDGED_BEFORE_THE_KILL: usize = 600;
const ANSWERS_THAT_LEAVE_THE_WRITE_UNSETTLED: [&str; 2] =
    ["DOC_ALREADY_EXISTS", "REPLICATION_OUTCOME_UNKNOWN"];

#[derive(Default)]
pub struct Outcomes {
    acknowledged: BTreeMap<String, String>,
    unsettled: Vec<(String, ClusterError)>,
    rounds_after_the_kill: Vec<WriteBatchResult>,
    singles_after_the_kill: Vec<(String, Result<(), ClusterError>)>,
}

fn round_of(round: usize) -> Vec<Map> {
    (0..BATCH_SIZE)
        .map(|serial| {
            let document_id = format!("round-{round}-{serial}");
            [
                ("id", Value::from(document_id.as_str())),
                ("title", Value::from(title_of(&document_id))),
            ]
            .into_iter()
            .collect()
        })
        .collect()
}

fn record(outcomes: &Mutex<Outcomes>, result: &WriteBatchResult) {
    let mut outcomes = outcomes.lock().expect("no writer panicked");
    for document_id in &result.succeeded {
        outcomes
            .acknowledged
            .insert(document_id.clone(), title_of(document_id));
    }
    for failure in &result.failed {
        outcomes
            .unsettled
            .push((failure.document_id.clone(), failure.error.clone()));
    }
}

async fn write_rounds_past_the_kill(
    router: &DataNode,
    outcomes: &Mutex<Outcomes>,
    killed: &AtomicBool,
) {
    for round in 0.. {
        let started_after_the_kill = killed.load(Ordering::Acquire);
        let result = router
            .node
            .insert_batch(LEDGER, round_of(round))
            .await
            .expect("the router routes every round");
        record(outcomes, &result);
        if started_after_the_kill {
            outcomes
                .lock()
                .expect("no writer panicked")
                .rounds_after_the_kill
                .push(result);
            return;
        }
    }
}

async fn write_singly_past_the_kill(
    router: &DataNode,
    writer: usize,
    outcomes: &Mutex<Outcomes>,
    killed: &AtomicBool,
) {
    for serial in 0.. {
        let started_after_the_kill = killed.load(Ordering::Acquire);
        let document_id = format!("single-{writer}-{serial}");
        let mut document = Map::new();
        document.insert("title", Value::from(title_of(&document_id)));
        let answer = router
            .node
            .insert(LEDGER, document, Some(&document_id))
            .await
            .map(|_| ());
        let mut outcomes = outcomes.lock().expect("no writer panicked");
        match &answer {
            Ok(()) => {
                let title = title_of(&document_id);
                outcomes.acknowledged.insert(document_id.clone(), title);
            }
            Err(error) => outcomes
                .unsettled
                .push((document_id.clone(), error.clone())),
        }
        if started_after_the_kill {
            outcomes.singles_after_the_kill.push((document_id, answer));
            return;
        }
    }
}

async fn kill_once_acknowledged(
    outcomes: &Mutex<Outcomes>,
    killed: &AtomicBool,
    kill: impl Future<Output = ()>,
) {
    eventually("the primary acknowledges the first writes", || async {
        outcomes
            .lock()
            .expect("no writer panicked")
            .acknowledged
            .len()
            >= ACKNOWLEDGED_BEFORE_THE_KILL
    })
    .await;
    killed.store(true, Ordering::Release);
    kill.await;
}

pub async fn write_rounds_across_a_kill(
    router: &DataNode,
    kill: impl Future<Output = ()>,
) -> Outcomes {
    let outcomes = Mutex::new(Outcomes::default());
    let killed = AtomicBool::new(false);
    tokio::join!(
        write_rounds_past_the_kill(router, &outcomes, &killed),
        kill_once_acknowledged(&outcomes, &killed, kill)
    );
    outcomes.into_inner().expect("no writer panicked")
}

pub async fn write_rounds_and_single_writes_across_a_kill(
    router: &DataNode,
    kill: impl Future<Output = ()>,
) -> Outcomes {
    let outcomes = Mutex::new(Outcomes::default());
    let killed = AtomicBool::new(false);
    tokio::join!(
        write_rounds_past_the_kill(router, &outcomes, &killed),
        write_singly_past_the_kill(router, 0, &outcomes, &killed),
        write_singly_past_the_kill(router, 1, &outcomes, &killed),
        kill_once_acknowledged(&outcomes, &killed, kill)
    );
    outcomes.into_inner().expect("no writer panicked")
}

impl Outcomes {
    pub fn acknowledged(&self) -> usize {
        self.acknowledged.len()
    }

    pub fn must_be_held(&self) -> BTreeMap<String, String> {
        let mut held = self.acknowledged.clone();
        for (document_id, error) in &self.unsettled {
            assert!(
                ANSWERS_THAT_LEAVE_THE_WRITE_UNSETTLED.contains(&error.code()),
                "{document_id} failed with {error:?}"
            );
            if error.code() == "DOC_ALREADY_EXISTS" {
                held.insert(document_id.clone(), title_of(document_id));
            }
        }
        held
    }

    pub fn assert_one_clean_round_after_the_kill(&self) {
        let after_the_kill = &self.rounds_after_the_kill;
        assert_eq!(after_the_kill.len(), 1);
        assert!(
            after_the_kill[0].failed.is_empty(),
            "a round sent after the kill reaches the promoted replica: {:?}",
            after_the_kill[0].failed.first()
        );
        assert_eq!(after_the_kill[0].succeeded.len(), BATCH_SIZE);
        for (document_id, answer) in &self.singles_after_the_kill {
            assert!(
                answer.is_ok(),
                "a single write sent after the kill reaches the promoted replica: {document_id} {answer:?}"
            );
        }
    }
}
