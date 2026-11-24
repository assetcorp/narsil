#![cfg(target_os = "linux")]

use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use narsil::{ErrorCode, Narsil};
use narsil_server::{NarsilServer, ServerOptions};
use tokio::runtime::Runtime;

const RECONNECTING_CLIENTS: usize = 600;
const HANDSHAKE_WAIT: Duration = Duration::from_secs(1);
const CONFIGURED_QUEUE_LENGTH: u32 = 32;

fn paused_runtime() -> Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the runtime starts")
}

fn listen(runtime: &Runtime, options: ServerOptions) -> (NarsilServer, u16) {
    let server = NarsilServer::new(
        Arc::new(Narsil::new()),
        ServerOptions {
            port: Some(0),
            ..options
        },
    )
    .expect("the server accepts its options");
    let port = runtime.block_on(async {
        server.listen().await.expect("the server listens");
        server
            .listening_port()
            .await
            .expect("the server has a port")
    });
    (server, port)
}

fn connect_until_refused(port: u16, attempts: usize) -> Vec<TcpStream> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut connected = Vec::with_capacity(attempts);
    for _ in 0..attempts {
        match TcpStream::connect_timeout(&address, HANDSHAKE_WAIT) {
            Ok(stream) => connected.push(stream),
            Err(_) => break,
        }
    }
    connected
}

#[test]
fn every_client_of_a_reconnect_burst_completes_its_handshake_while_the_server_is_busy() {
    let runtime = paused_runtime();
    let (server, port) = listen(&runtime, ServerOptions::default());

    let connected = connect_until_refused(port, RECONNECTING_CLIENTS);

    assert_eq!(
        connected.len(),
        RECONNECTING_CLIENTS,
        "the system held only {} of {RECONNECTING_CLIENTS} connections for a server that had not accepted them yet",
        connected.len()
    );
    drop(connected);
    runtime
        .block_on(server.shutdown())
        .expect("the server shuts down");
}

#[test]
fn the_server_holds_the_queue_length_that_its_options_set_and_refuses_an_empty_queue() {
    let refused = NarsilServer::new(
        Arc::new(Narsil::new()),
        ServerOptions {
            accept_queue_length: Some(0),
            ..ServerOptions::default()
        },
    );
    match refused {
        Ok(_) => panic!("the server accepted a queue that holds no connection"),
        Err(failure) => assert_eq!(failure.code(), ErrorCode::CONFIG_INVALID),
    }

    let runtime = paused_runtime();
    let (server, port) = listen(
        &runtime,
        ServerOptions {
            accept_queue_length: Some(CONFIGURED_QUEUE_LENGTH),
            ..ServerOptions::default()
        },
    );

    let connected = connect_until_refused(port, RECONNECTING_CLIENTS);

    let queue_length = CONFIGURED_QUEUE_LENGTH as usize;
    assert!(
        (queue_length..=queue_length + 1).contains(&connected.len()),
        "the system held {} connections for a queue of {CONFIGURED_QUEUE_LENGTH}",
        connected.len()
    );
    drop(connected);
    runtime
        .block_on(server.shutdown())
        .expect("the server shuts down");
}
