use std::io;
use std::net::SocketAddr;

use tokio::net::{TcpListener, TcpSocket, lookup_host};

fn listen_on(address: SocketAddr, accept_queue_length: u32) -> io::Result<TcpListener> {
    let socket = if address.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    #[cfg(not(windows))]
    socket.set_reuseaddr(true)?;
    socket.bind(address)?;
    socket.listen(accept_queue_length)
}

pub(crate) async fn bind(
    host: &str,
    port: u16,
    accept_queue_length: u32,
) -> io::Result<TcpListener> {
    let mut last_failure = None;
    for address in lookup_host((host, port)).await? {
        match listen_on(address, accept_queue_length) {
            Ok(listener) => return Ok(listener),
            Err(failure) => last_failure = Some(failure),
        }
    }
    Err(last_failure.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "could not resolve to any address",
        )
    }))
}
