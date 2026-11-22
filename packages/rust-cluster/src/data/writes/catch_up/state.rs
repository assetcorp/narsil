use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use tokio::sync::watch;

use crate::allocator::Assignment;
use crate::error::ClusterResult;
use crate::node::generate_node_id;

pub(in crate::data::writes) type Registered = Option<HashMap<String, String>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::data::writes) enum AdmissionAnswer {
    Accepted,
    Refused,
    Unanswered,
}

pub(in crate::data::writes) struct Feed {
    cancelled: watch::Sender<bool>,
    primary_term: u64,
    in_sync: Vec<String>,
    replica_started_at: Option<String>,
}

fn in_sync_signature(assignment: &Assignment) -> Vec<String> {
    let mut members = assignment.in_sync_set.clone();
    members.sort();
    members
}

impl Feed {
    pub(in crate::data::writes) fn new(
        assignment: &Assignment,
        replica_started_at: Option<String>,
    ) -> Arc<Feed> {
        Arc::new(Feed {
            cancelled: watch::Sender::new(false),
            primary_term: assignment.primary_term as u64,
            in_sync: in_sync_signature(assignment),
            replica_started_at,
        })
    }

    pub(in crate::data::writes) fn cancel(&self) {
        self.cancelled.send_replace(true);
    }

    pub(in crate::data::writes) fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    pub(in crate::data::writes) async fn until_cancelled<T>(
        &self,
        work: impl Future<Output = T>,
        fallback: T,
    ) -> T {
        if self.is_cancelled() {
            return fallback;
        }
        let mut cancelled = self.cancelled.subscribe();
        tokio::select! {
            biased;
            output = work => output,
            _ = cancelled.wait_for(|cancelled| *cancelled) => fallback,
        }
    }

    pub(in crate::data::writes) fn is_stale(
        &self,
        assignment: &Assignment,
        registered: &Registered,
        replica_node_id: &str,
    ) -> bool {
        let replica_left = registered.as_ref().is_some_and(|registered| {
            registered.get(replica_node_id) != self.replica_started_at.as_ref()
        });
        replica_left
            || assignment.primary_term as u64 != self.primary_term
            || in_sync_signature(assignment) != self.in_sync
    }
}

pub(in crate::data::writes) struct Cursor {
    pub(in crate::data::writes) applied_seq_no: u64,
    pub(in crate::data::writes) confirmed: bool,
    pub(in crate::data::writes) busy: bool,
    pub(in crate::data::writes) sync_epoch: u64,
    pub(in crate::data::writes) feed: Option<Arc<Feed>>,
}

impl Cursor {
    fn open_fresh_session(&mut self, applied_seq_no: u64) {
        if let Some(feed) = &self.feed {
            feed.cancel();
        }
        self.applied_seq_no = applied_seq_no;
        self.sync_epoch += 1;
    }
}

struct SyncSession {
    id: String,
    primary_term: u64,
}

pub(in crate::data::writes) struct PendingAdmission {
    pub(in crate::data::writes) claim: u64,
    pub(in crate::data::writes) failed_write: bool,
    pub(in crate::data::writes) unanswered: bool,
    pub(in crate::data::writes) answer: Option<watch::Receiver<Option<AdmissionAnswer>>>,
}

#[derive(Debug, Clone, Copy)]
pub(in crate::data::writes) struct AdmittedReplica {
    pub(in crate::data::writes) primary_term: u64,
    pub(in crate::data::writes) generation: u64,
    pub(in crate::data::writes) in_sync_version: u64,
}

pub(in crate::data::writes) struct ToWithdraw {
    pub(in crate::data::writes) claim: u64,
    pub(in crate::data::writes) primary_term: u64,
    pub(in crate::data::writes) withdrawing: bool,
}

#[derive(Default)]
pub(in crate::data::writes) struct CatchUp {
    pub(in crate::data::writes) cursors: HashMap<String, Cursor>,
    sessions: HashMap<String, SyncSession>,
    pub(in crate::data::writes) pending: HashMap<String, PendingAdmission>,
    pub(in crate::data::writes) admitted: HashMap<String, AdmittedReplica>,
    pub(in crate::data::writes) to_withdraw: HashMap<String, ToWithdraw>,
    generations: HashMap<String, u64>,
    last_generation: u64,
    last_claim: u64,
    pub(in crate::data::writes) settling: bool,
}

impl CatchUp {
    pub(in crate::data::writes) fn is_idle(&self) -> bool {
        self.cursors.is_empty() && self.to_withdraw.is_empty() && self.admitted.is_empty()
    }

    pub(in crate::data::writes) fn last_generation(&self) -> u64 {
        self.last_generation
    }

    pub(in crate::data::writes) fn next_claim(&mut self) -> u64 {
        self.last_claim += 1;
        self.last_claim
    }

    pub(in crate::data::writes) fn open_session(
        &mut self,
        replica_node_id: &str,
        primary_term: u64,
        assigned: &[String],
    ) -> ClusterResult<String> {
        self.sessions.retain(|node_id, session| {
            session.primary_term == primary_term && assigned.contains(node_id)
        });
        let id = generate_node_id()?;
        self.sessions.insert(
            replica_node_id.to_string(),
            SyncSession {
                id: id.clone(),
                primary_term,
            },
        );
        Ok(id)
    }

    pub(in crate::data::writes) fn is_current_session(
        &self,
        replica_node_id: &str,
        sync_session: &str,
        primary_term: u64,
    ) -> bool {
        self.sessions.get(replica_node_id).is_some_and(|session| {
            session.id == sync_session && session.primary_term == primary_term
        })
    }

    pub(in crate::data::writes) fn record_position(
        &mut self,
        replica_node_id: &str,
        applied_seq_no: u64,
        log_end: u64,
        confirms_position: bool,
    ) {
        let reported = applied_seq_no.min(log_end);
        match self.cursors.get_mut(replica_node_id) {
            None => {
                self.cursors.insert(
                    replica_node_id.to_string(),
                    Cursor {
                        applied_seq_no: reported,
                        confirmed: confirms_position,
                        busy: false,
                        sync_epoch: 0,
                        feed: None,
                    },
                );
            }
            Some(cursor) => {
                if !confirms_position || reported < cursor.applied_seq_no {
                    cursor.open_fresh_session(reported);
                } else {
                    cursor.applied_seq_no = reported;
                }
                cursor.confirmed = confirms_position;
            }
        }
    }

    pub(in crate::data::writes) fn record_snapshot_request(&mut self, replica_node_id: &str) {
        let Some(mut cursor) = self.cursors.remove(replica_node_id) else {
            return;
        };
        cursor.open_fresh_session(0);
    }

    pub(in crate::data::writes) fn forget_replica(&mut self, replica_node_id: &str) {
        if let Some(cursor) = self.cursors.remove(replica_node_id)
            && let Some(feed) = cursor.feed
        {
            feed.cancel();
        }
        if self
            .pending
            .get(replica_node_id)
            .is_some_and(|pending| pending.answer.is_none())
        {
            self.pending.remove(replica_node_id);
        }
    }

    pub(in crate::data::writes) fn cancel_feeds(&self) {
        for cursor in self.cursors.values() {
            if let Some(feed) = &cursor.feed {
                feed.cancel();
            }
        }
    }

    pub(in crate::data::writes) fn forget_led_state(&mut self) {
        self.cancel_feeds();
        self.cursors.clear();
        self.sessions.clear();
        self.pending.clear();
        self.to_withdraw.clear();
        self.admitted.clear();
    }

    pub(in crate::data::writes) fn pending_admissions(&self) -> Vec<String> {
        self.pending.keys().cloned().collect()
    }

    pub(in crate::data::writes) fn advance_generation(&mut self, replica_node_id: &str) -> u64 {
        self.last_generation += 1;
        self.generations
            .insert(replica_node_id.to_string(), self.last_generation);
        self.last_generation
    }

    pub(in crate::data::writes) fn generation_of(&mut self, replica_node_id: &str) -> u64 {
        match self.generations.get(replica_node_id) {
            Some(generation) => *generation,
            None => self.advance_generation(replica_node_id),
        }
    }

    pub(in crate::data::writes) fn generation_is(
        &self,
        replica_node_id: &str,
        generation: u64,
    ) -> bool {
        self.generations.get(replica_node_id) == Some(&generation)
    }

    pub(in crate::data::writes) fn clear_pending(&mut self, replica_node_id: &str, claim: u64) {
        if self
            .pending
            .get(replica_node_id)
            .is_some_and(|pending| pending.claim == claim)
        {
            self.pending.remove(replica_node_id);
        }
    }
}
