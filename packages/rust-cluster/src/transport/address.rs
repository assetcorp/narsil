use narsil::Value;

use crate::error::{ClusterError, ClusterResult, codes};

const UNADDRESSABLE_TARGET_DETAIL: &str = "unaddressableTarget";

pub(crate) struct PeerAddress {
    pub(crate) host: String,
    pub(crate) port: u16,
}

fn unaddressable(address: &str, message: String) -> ClusterError {
    ClusterError::new(codes::TRANSPORT_CONNECT_FAILED, message)
        .with_detail("address", Value::String(address.to_string()))
        .with_detail(UNADDRESSABLE_TARGET_DETAIL, Value::Bool(true))
}

pub(crate) fn parse_address(address: &str) -> ClusterResult<PeerAddress> {
    let (host, port) = if let Some(bracketed) = address.strip_prefix('[') {
        let Some(closing) = bracketed.find("]:") else {
            return Err(unaddressable(
                address,
                format!("Invalid address format '{address}', expected [IPv6 address]:port"),
            ));
        };
        (&bracketed[..closing], &bracketed[closing + 2..])
    } else {
        let Some(colon) = address.rfind(':') else {
            return Err(unaddressable(
                address,
                format!("Invalid address format '{address}', expected host:port"),
            ));
        };
        (&address[..colon], &address[colon + 1..])
    };
    if host.is_empty() || host.contains(['\0', '[', ']']) {
        return Err(unaddressable(
            address,
            format!("Invalid host in address '{address}'"),
        ));
    }
    let port = port
        .bytes()
        .all(|byte| byte.is_ascii_digit())
        .then(|| port.parse::<u16>().ok())
        .flatten()
        .filter(|port| *port > 0);
    let Some(port) = port else {
        return Err(unaddressable(
            address,
            format!("Invalid port in target address '{address}'"),
        ));
    };
    Ok(PeerAddress {
        host: host.to_string(),
        port,
    })
}
