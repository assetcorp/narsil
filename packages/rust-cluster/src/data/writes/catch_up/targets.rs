use narsil::Value;
use tokio::sync::watch;
use tokio::time::Instant;

use super::admitted::Fenced;
use super::state::AdmissionAnswer;
use crate::allocator::Assignment;
use crate::controller::lock;
use crate::data::writes::PrimaryWrites;
use crate::data::writes::errors::insync_removal_failed;
use crate::data::writes::partition::Partition;
use crate::data::writes::scope::Scope;
use crate::error::ClusterResult;

pub(in crate::data::writes) struct Targets {
    pub(in crate::data::writes) admitted: Vec<String>,
    pub(in crate::data::writes) replicas: Vec<String>,
}

struct Failures {
    in_sync: Vec<String>,
    unanswered: Vec<String>,
    fenced: Vec<(String, Fenced)>,
}

pub(in crate::data::writes) fn in_sync_targets_with(
    assignment: &Assignment,
    node_id: &str,
    extra: &[String],
) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    for replica in assignment.in_sync_set.iter().chain(extra) {
        if replica != node_id && assignment.holds_replica(replica) && !targets.contains(replica) {
            targets.push(replica.clone());
        }
    }
    targets
}

async fn answer_by(
    mut answer: watch::Receiver<Option<AdmissionAnswer>>,
    deadline: Instant,
) -> AdmissionAnswer {
    let settled = tokio::time::timeout_at(deadline, answer.wait_for(Option::is_some)).await;
    match settled {
        Ok(Ok(settled)) => settled.unwrap_or(AdmissionAnswer::Refused),
        Ok(Err(_)) => AdmissionAnswer::Refused,
        Err(_) => AdmissionAnswer::Unanswered,
    }
}

fn names(replicas: &[String]) -> Value {
    Value::Array(replicas.iter().map(|id| Value::from(id.as_str())).collect())
}

impl PrimaryWrites {
    pub(in crate::data::writes) fn replica_targets(
        &self,
        partition: &Partition,
        scope: &Scope,
        assignment: &Assignment,
    ) -> Targets {
        let (admitted, targets) = {
            let mut catch_up = lock(&partition.catch_up);
            let admitted = catch_up.admitted_beyond_table(assignment, None);
            let mut extra = catch_up.pending_admissions();
            extra.extend(admitted.iter().cloned());
            let targets = in_sync_targets_with(assignment, &self.node_id, &extra);
            (admitted, catch_up.with_unanswered(&self.node_id, targets))
        };
        let terms = lock(&partition.terms);
        let replicas = targets
            .into_iter()
            .filter(|replica| !terms.removed_under(replica, scope.primary_term))
            .collect();
        Targets { admitted, replicas }
    }

    async fn in_sync_failures(
        &self,
        partition: &Partition,
        failed: &[String],
        assignment: &Assignment,
        admitted: &[String],
    ) -> Failures {
        let mut failures = Failures {
            in_sync: Vec::new(),
            unanswered: Vec::new(),
            fenced: Vec::new(),
        };
        let mut answers = Vec::new();
        {
            let mut catch_up = lock(&partition.catch_up);
            let admitted_now = catch_up.admitted_beyond_table(assignment, None);
            for replica in failed {
                if assignment.holds_in_sync(replica)
                    || admitted.contains(replica)
                    || admitted_now.contains(replica)
                {
                    failures.in_sync.push(replica.clone());
                    continue;
                }
                let owed = catch_up.to_withdraw.get(replica).map(|owed| owed.claim);
                let Some(pending) = catch_up.pending.get_mut(replica) else {
                    continue;
                };
                if pending.unanswered {
                    failures.in_sync.push(replica.clone());
                    let fenced = Fenced {
                        pending: Some(pending.claim),
                        owed,
                    };
                    failures.fenced.push((replica.clone(), fenced));
                    continue;
                }
                pending.failed_write = true;
                match pending.answer.clone() {
                    Some(answer) => answers.push((replica.clone(), answer)),
                    None => {
                        let claim = pending.claim;
                        catch_up.clear_pending(replica, claim);
                    }
                }
            }
        }
        let deadline = Instant::now() + self.replication_timeout();
        for (replica, answer) in answers {
            match answer_by(answer, deadline).await {
                AdmissionAnswer::Accepted => failures.in_sync.push(replica),
                AdmissionAnswer::Unanswered => failures.unanswered.push(replica),
                AdmissionAnswer::Refused => {}
            }
        }
        failures
    }

    pub(in crate::data::writes) async fn remove_in_sync_failures(
        &self,
        partition: &Partition,
        scope: &Scope,
        failed: &[String],
        assignment: &Assignment,
        admitted: &[String],
    ) -> ClusterResult<()> {
        let failures = self
            .in_sync_failures(partition, failed, assignment, admitted)
            .await;
        self.remove_failed(scope, &failures.in_sync).await?;
        {
            let mut catch_up = lock(&partition.catch_up);
            for (replica, fenced) in &failures.fenced {
                catch_up.settle_fenced(replica, fenced);
            }
        }
        if failures.unanswered.is_empty() {
            return Ok(());
        }
        self.view.refresh(&scope.index_name).await?;
        self.assert_authority(scope).await?;
        let timeout_ms = self.replication_timeout().as_millis() as u64;
        let listed: Vec<String> = failures
            .unanswered
            .iter()
            .map(|replica| format!("'{replica}'"))
            .collect();
        Err(insync_removal_failed(
            scope,
            format!(
                "The controller did not answer the admission of {} to index '{}' partition {} within {timeout_ms}ms after a failed write, so the primary cannot tell whether to remove it",
                listed.join(", "),
                scope.index_name,
                scope.partition_id
            ),
            None,
        )
        .with_detail("unansweredReplicas", names(&failures.unanswered))
        .with_detail("timeoutMs", Value::from(timeout_ms)))
    }
}
