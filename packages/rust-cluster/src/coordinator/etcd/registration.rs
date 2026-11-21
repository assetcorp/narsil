use std::sync::Arc;
use std::time::Duration;

use etcd_client::{Compare, CompareOp, PutOptions, Txn, TxnOp};

use super::Inner;
use super::client::EtcdWrite;
use super::leases::ManagedLease;
use crate::constants::{RECONNECT_FIRST_DELAY_MS, RECONNECT_LONGEST_DELAY_MS};
use crate::coordinator::serialization::{decode_registration, encode_registration};
use crate::coordinator::types::NodeRegistration;
use crate::error::ClusterResult;

const OPERATION: &str = "registerNode";

pub(crate) struct RegistrationKeys {
    pub(crate) key: String,
    pub(crate) started_at_key: String,
}

fn registration_txn(
    keys: &RegistrationKeys,
    lease: &ManagedLease,
    started_at: &str,
    payload: &[u8],
) -> Txn {
    let under_lease = || Some(PutOptions::new().with_lease(lease.id));
    Txn::new()
        .when(vec![Compare::create_revision(
            keys.key.clone(),
            CompareOp::Greater,
            -1,
        )])
        .and_then(vec![
            TxnOp::put(
                keys.started_at_key.clone(),
                started_at.as_bytes().to_vec(),
                under_lease(),
            ),
            TxnOp::put(keys.key.clone(), payload.to_vec(), under_lease()),
        ])
}

async fn put_under_lease(
    inner: &Inner,
    keys: &RegistrationKeys,
    lease: &ManagedLease,
    started_at: &str,
    payload: &[u8],
) -> ClusterResult<()> {
    let write = EtcdWrite {
        key: &keys.key,
        value_bytes: payload.len(),
        expected_bytes: 0,
    };
    inner
        .guarded_txn(
            OPERATION,
            &write,
            registration_txn(keys, lease, started_at, payload),
        )
        .await?;
    Ok(())
}

pub(crate) async fn write_node_registration(
    inner: &Arc<Inner>,
    keys: RegistrationKeys,
    registration: &NodeRegistration,
) -> ClusterResult<()> {
    let _exclusive = inner.leases.exclusively(&keys.key).await;
    let payload = encode_registration(registration)?;
    inner.guard.require_fits(&EtcdWrite {
        key: &keys.key,
        value_bytes: payload.len(),
        expected_bytes: 0,
    })?;
    if let Some(tracked) = inner
        .leases
        .get_by_node_id(&keys.key, &registration.node_id)
    {
        let renewed = async {
            tracked.lease.keepalive_once().await?;
            if inner.leases.holds_payload(&keys.key, &payload) {
                return Ok(());
            }
            put_under_lease(
                inner,
                &keys,
                &tracked.lease,
                &registration.started_at,
                &payload,
            )
            .await?;
            inner.leases.track(
                &keys.key,
                Arc::clone(&tracked.lease),
                &registration.node_id,
                Some(payload.clone()),
            );
            ClusterResult::Ok(())
        };
        match renewed.await {
            Ok(()) => return Ok(()),
            Err(_) => {
                inner.leases.remove(&keys.key);
            }
        }
    }
    let lease = ManagedLease::grant(Arc::clone(&inner.pool), inner.ttl_seconds).await?;
    if let Err(error) =
        put_under_lease(inner, &keys, &lease, &registration.started_at, &payload).await
    {
        lease.revoke().await;
        return Err(error);
    }
    let existing = inner.leases.get(&keys.key);
    inner.leases.track(
        &keys.key,
        Arc::clone(&lease),
        &registration.node_id,
        Some(payload),
    );
    register_again_on_loss(inner, keys, &lease, registration.node_id.clone());
    if let Some(existing) = existing.filter(|existing| !Arc::ptr_eq(&existing.lease, &lease)) {
        existing.lease.revoke().await;
    }
    Ok(())
}

fn register_again_on_loss(
    inner: &Arc<Inner>,
    keys: RegistrationKeys,
    lease: &Arc<ManagedLease>,
    node_id: String,
) {
    let mut lost = lease.lost();
    let watched = Arc::downgrade(lease);
    let owner = Arc::downgrade(inner);
    tokio::spawn(async move {
        if lost.wait_for(|gone| *gone).await.is_err() {
            return;
        }
        let mut delay = Duration::from_millis(RECONNECT_FIRST_DELAY_MS);
        loop {
            let Some(inner) = owner.upgrade() else {
                return;
            };
            let Some(lost_lease) = watched.upgrade() else {
                return;
            };
            if restore_lost_registration(&inner, &keys, &lost_lease, &node_id).await {
                return;
            }
            drop(lost_lease);
            drop(inner);
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_millis(RECONNECT_LONGEST_DELAY_MS));
        }
    });
}

async fn restore_lost_registration(
    inner: &Arc<Inner>,
    keys: &RegistrationKeys,
    lost: &Arc<ManagedLease>,
    node_id: &str,
) -> bool {
    let _exclusive = inner.leases.exclusively(&keys.key).await;
    let Some(tracked) = inner.leases.get(&keys.key) else {
        return true;
    };
    let Some(payload) = tracked.payload.clone() else {
        return true;
    };
    if inner.is_shut_down() || !Arc::ptr_eq(&tracked.lease, lost) {
        return true;
    }
    let Ok(registration) = decode_registration(&payload) else {
        return true;
    };
    let Ok(lease) = ManagedLease::grant(Arc::clone(&inner.pool), inner.ttl_seconds).await else {
        return false;
    };
    if put_under_lease(inner, keys, &lease, &registration.started_at, &payload)
        .await
        .is_err()
    {
        lease.revoke().await;
        return false;
    }
    inner
        .leases
        .track(&keys.key, Arc::clone(&lease), node_id, Some(payload));
    register_again_on_loss(
        inner,
        RegistrationKeys {
            key: keys.key.clone(),
            started_at_key: keys.started_at_key.clone(),
        },
        &lease,
        node_id.to_string(),
    );
    true
}
