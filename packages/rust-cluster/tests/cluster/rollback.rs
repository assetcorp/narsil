use std::sync::Arc;
use std::time::Duration;

use narsil::Map;
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::message::TransportMessage;
use narsil_cluster::node::next_started_at;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use narsil_cluster::transport::{Listening, NodeTransport, Respond, listen_handler};
use tokio::sync::{mpsc, watch};

use crate::data_node::{Scratch, coordinator_at, etcd_endpoint, eventually, unique_key_prefix};
use crate::ledger::{
    Forwarded, Ledger, document_ids, first_difference, forward_insert, placement, start_cluster,
};
use crate::support::{decode, write_map_header, write_text, write_unsigned};

const INSYNC_REMOVAL_FAILED: &str = "REPLICATION_INSYNC_REMOVAL_FAILED";
const ROLLED_BACK: &str = "rolled-back-entry";
const CONTROLLER_LEASE_KEY: &str = "_narsil/controller";
const INSYNC_REMOVE: &str = "replication.insync_remove";
const INSYNC_CONFIRM: &str = "replication.insync_confirm";
const STAND_IN_CONTROLLER: &str = "ledger-stand-in-controller";
const STAND_IN_LEASE_MS: u64 = 300_000;
const STAND_IN_REGISTRATION_TTL_SECONDS: u64 = 300;
const REMOVAL_REQUEST_WAIT: Duration = Duration::from_secs(30);
const MSGPACK_FALSE: u8 = 0xc2;

fn refused_removal(request: &TransportMessage) -> TransportMessage {
    let asked = decode(&request.payload);
    let mut payload = Vec::new();
    write_map_header(&mut payload, 3);
    write_text(&mut payload, "indexName");
    write_text(&mut payload, &asked.text("indexName"));
    write_text(&mut payload, "partitionId");
    write_unsigned(&mut payload, asked.unsigned("partitionId"));
    write_text(&mut payload, "accepted");
    payload.push(MSGPACK_FALSE);
    TransportMessage::new(
        INSYNC_CONFIRM,
        STAND_IN_CONTROLLER,
        request.request_id.clone(),
        payload,
    )
}

struct StandInController {
    coordinator: Arc<EtcdCoordinator>,
    transport: TcpTransport,
    listening: Listening,
    removals: mpsc::UnboundedReceiver<String>,
    release: watch::Sender<bool>,
}

impl StandInController {
    async fn register(endpoint: String, key_prefix: String) -> StandInController {
        let coordinator =
            coordinator_at(endpoint, key_prefix, STAND_IN_REGISTRATION_TTL_SECONDS).await;
        let transport = TcpTransport::new(
            STAND_IN_CONTROLLER,
            TcpTransportConfig {
                host: "127.0.0.1".to_string(),
                port: 0,
                ..TcpTransportConfig::default()
            },
        )
        .expect("the stand-in controller's transport settings are valid");
        let (removed, removals) = mpsc::unbounded_channel();
        let (release, released) = watch::channel(false);
        let handler = listen_handler(move |message: TransportMessage, respond: Respond| {
            let removed = removed.clone();
            let mut released = released.clone();
            async move {
                if message.message_type != INSYNC_REMOVE {
                    return Ok(());
                }
                let _ = removed.send(decode(&message.payload).text("replicaNodeId"));
                let _ = released.wait_for(|released| *released).await;
                respond.send(refused_removal(&message)).await;
                Ok(())
            }
        });
        let listening = transport
            .listen(handler)
            .await
            .expect("the stand-in controller listens");
        coordinator
            .register_node(&NodeRegistration {
                node_id: STAND_IN_CONTROLLER.to_string(),
                address: format!("127.0.0.1:{}", transport.port()),
                roles: vec!["coordinator".to_string()],
                capacity: NodeCapacity::default(),
                started_at: next_started_at(),
                version: SPEC_VERSION.to_string(),
                extra: Map::new(),
            })
            .await
            .expect("etcd takes the stand-in controller's registration");
        StandInController {
            coordinator,
            transport,
            listening,
            removals,
            release,
        }
    }

    async fn take_the_lease(&self) {
        eventually(
            "the stand-in controller takes the controller lease",
            || async {
                self.coordinator
                    .acquire_lease(CONTROLLER_LEASE_KEY, STAND_IN_CONTROLLER, STAND_IN_LEASE_MS)
                    .await
                    .expect("etcd answers for the lease")
            },
        )
        .await;
    }

    async fn first_removal(&mut self) -> String {
        tokio::time::timeout(REMOVAL_REQUEST_WAIT, self.removals.recv())
            .await
            .expect("the primary asks the controller to remove the copy that it could not reach")
            .expect("the stand-in controller is listening")
    }

    async fn stop(self) {
        let _ = self.release.send(true);
        self.listening.stop();
        let _ = self.coordinator.release_lease(CONTROLLER_LEASE_KEY).await;
        let _ = self.coordinator.deregister_node(STAND_IN_CONTROLLER).await;
        self.transport.shutdown().await;
        self.coordinator.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_primary_rolls_back_a_write_that_it_could_not_replicate_once_its_in_sync_copy_returns()
 {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let mut stand_in = StandInController::register(endpoint.clone(), key_prefix.clone()).await;
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint, key_prefix, ttl).await;
    let controller_scratch = Scratch::new();
    let (controller, mut members, primary_at) =
        start_cluster(&coordinator, &controller_scratch).await;
    let replica_at = 1 - primary_at;
    let replica_id = members[replica_at].node_id;
    let mut ledger = Ledger::new();
    ledger
        .insert_all(members[primary_at].data(), &document_ids("settled", 3))
        .await;

    controller.stop().await;
    stand_in.take_the_lease().await;
    members[replica_at].stop().await;
    let primary_address = members[primary_at].data().address.clone();
    let forwarder = crate::ledger::forwarder();
    let write = tokio::spawn(async move {
        let forwarded = forward_insert(&forwarder, &primary_address, ROLLED_BACK).await;
        forwarder.shutdown().await;
        forwarded
    });
    assert_eq!(stand_in.first_removal().await, replica_id);
    members[replica_at].restart(&coordinator).await;
    let _ = stand_in.release.send(true);
    let forwarded = write.await.expect("the write ends without a panic");

    let Forwarded::Refused(refused) = forwarded else {
        panic!("the primary should refuse a write that no in-sync copy took");
    };
    assert_eq!(
        refused.text("code"),
        INSYNC_REMOVAL_FAILED,
        "every in-sync copy dropped the write, so the primary answers the failure that stopped it: {refused:?}"
    );
    let placed = placement(&coordinator).await.expect("the ledger is placed");
    assert!(
        placed.lists_in_sync(replica_id),
        "{replica_id} stays in sync"
    );
    let absent = [ROLLED_BACK.to_string()];
    for member in &members {
        let difference = first_difference(member.data(), &ledger.written, &absent).await;
        assert!(
            difference.is_none(),
            "{} holds the acknowledged writes and none of the rolled-back one: {difference:?}",
            member.node_id
        );
    }

    ledger.forwarder.shutdown().await;
    for member in &mut members {
        member.stop().await;
    }
    stand_in.stop().await;
    coordinator.shutdown().await;
}
