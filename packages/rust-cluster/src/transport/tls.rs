use std::sync::Arc;

use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use tokio_rustls::rustls::crypto::{CryptoProvider, ring};
use tokio_rustls::rustls::server::WebPkiClientVerifier;
use tokio_rustls::rustls::{ClientConfig, RootCertStore, ServerConfig};

use crate::error::{ClusterError, ClusterResult, codes};

const HTTP2_PROTOCOL: &[u8] = b"h2";

/// The certificate material that a node presents to its peers, each part in PEM form.
///
/// A transport with this material makes every connection mutual TLS: the listener requires a client certificate
/// that chains to `ca`, and the dialler checks the listener's certificate against `ca` and the host of the target
/// address.
#[derive(Clone)]
pub struct TlsConfig {
    /// This node's certificate chain.
    pub cert: Vec<u8>,
    /// The private key of that certificate.
    pub key: Vec<u8>,
    /// The authority that every peer certificate must chain to.
    pub ca: Vec<u8>,
}

impl std::fmt::Debug for TlsConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TlsConfig")
            .field("cert", &format_args!("{} bytes", self.cert.len()))
            .field("key", &"redacted")
            .field("ca", &format_args!("{} bytes", self.ca.len()))
            .finish()
    }
}

fn invalid(message: String) -> ClusterError {
    ClusterError::new(codes::CONFIG_INVALID, message)
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(ring::default_provider())
}

fn certificates(pem: &[u8], part: &str) -> ClusterResult<Vec<CertificateDer<'static>>> {
    let parsed = CertificateDer::pem_slice_iter(pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| invalid(format!("The TLS {part} is not a PEM certificate: {error}")))?;
    if parsed.is_empty() {
        return Err(invalid(format!("The TLS {part} holds no PEM certificate")));
    }
    Ok(parsed)
}

fn private_key(pem: &[u8]) -> ClusterResult<PrivateKeyDer<'static>> {
    PrivateKeyDer::from_pem_slice(pem)
        .map_err(|error| invalid(format!("The TLS key is not a PEM private key: {error}")))
}

fn roots(pem: &[u8]) -> ClusterResult<Arc<RootCertStore>> {
    let mut store = RootCertStore::empty();
    for certificate in certificates(pem, "ca")? {
        store
            .add(certificate)
            .map_err(|error| invalid(format!("The TLS ca is not a usable authority: {error}")))?;
    }
    Ok(Arc::new(store))
}

#[derive(Clone)]
pub(crate) struct TlsContexts {
    pub(crate) server: Arc<ServerConfig>,
    pub(crate) client: Arc<ClientConfig>,
}

pub(crate) fn tls_contexts(config: &TlsConfig, http2: bool) -> ClusterResult<TlsContexts> {
    let roots = roots(&config.ca)?;
    let chain = certificates(&config.cert, "cert")?;
    let key = private_key(&config.key)?;
    let verifier = WebPkiClientVerifier::builder_with_provider(Arc::clone(&roots), provider())
        .build()
        .map_err(|error| invalid(format!("The TLS ca cannot verify clients: {error}")))?;
    let mut server = ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|error| invalid(format!("The TLS provider refused its defaults: {error}")))?
        .with_client_cert_verifier(verifier)
        .with_single_cert(chain.clone(), key.clone_key())
        .map_err(|error| invalid(format!("The TLS cert and key do not pair: {error}")))?;
    let mut client = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|error| invalid(format!("The TLS provider refused its defaults: {error}")))?
        .with_root_certificates(roots)
        .with_client_auth_cert(chain, key)
        .map_err(|error| invalid(format!("The TLS cert and key do not pair: {error}")))?;
    if http2 {
        server.alpn_protocols = vec![HTTP2_PROTOCOL.to_vec()];
        client.alpn_protocols = vec![HTTP2_PROTOCOL.to_vec()];
    }
    Ok(TlsContexts {
        server: Arc::new(server),
        client: Arc::new(client),
    })
}

pub(crate) fn server_name(host: &str, target: &str) -> ClusterResult<ServerName<'static>> {
    ServerName::try_from(host.to_string()).map_err(|_| {
        ClusterError::new(
            codes::TRANSPORT_CONNECT_FAILED,
            format!("The host of '{target}' is neither a DNS name nor an IP address"),
        )
    })
}
