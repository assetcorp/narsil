use narsil_server::RequestContext;
use sha2::{Digest, Sha256};

use super::constants::FEED_SUBPROTOCOLS;
use super::token::{Role, SigningKeys, VerifiedToken, constant_time_equal, verify_token};
use crate::events::body::now_ms;
use crate::settings::types::AccessKeys;

const BEARER_SCHEME: &str = "bearer";

pub enum Credential {
    Key(Role),
    Token(VerifiedToken),
}

impl Credential {
    pub fn role(&self) -> Role {
        match self {
            Credential::Key(role) => *role,
            Credential::Token(token) => token.role,
        }
    }
}

pub struct CredentialVerifier {
    digests: Vec<(Role, Vec<u8>)>,
    signing: SigningKeys,
}

fn digest_of(value: &str) -> Vec<u8> {
    Sha256::digest(value.as_bytes()).to_vec()
}

fn is_blank(character: char) -> bool {
    character == ' ' || character == '\t'
}

fn bearer_value(authorization: &str) -> Option<&str> {
    let scheme = authorization.get(..BEARER_SCHEME.len())?;
    if !scheme.eq_ignore_ascii_case(BEARER_SCHEME) {
        return None;
    }
    let rest = &authorization[BEARER_SCHEME.len()..];
    let value = rest.trim_start_matches(is_blank);
    if value.len() == rest.len() {
        return None;
    }
    let value = value.trim_end_matches(is_blank);
    (!value.is_empty() && !value.contains(is_blank)).then_some(value)
}

fn presented_value(context: &RequestContext) -> Option<&str> {
    if let Some(authorization) = context.headers.get("authorization") {
        return bearer_value(authorization);
    }
    let offered = context.headers.get("sec-websocket-protocol")?;
    if context.method != "GET" {
        return None;
    }
    let protocols: Vec<&str> = offered.split(',').map(str::trim).collect();
    let position = protocols
        .iter()
        .position(|protocol| FEED_SUBPROTOCOLS.contains(protocol))?;
    protocols
        .get(position + 1)
        .copied()
        .filter(|value| !value.is_empty())
}

impl CredentialVerifier {
    pub fn new(keys: &AccessKeys) -> CredentialVerifier {
        let mut digests = Vec::new();
        if let Some(admin) = &keys.admin {
            digests.push((Role::Admin, digest_of(admin)));
        }
        if let Some(read) = &keys.read {
            digests.push((Role::Read, digest_of(read)));
        }
        CredentialVerifier {
            digests,
            signing: SigningKeys {
                admin: keys.admin.as_ref().map(|key| key.as_bytes().to_vec()),
                read: keys.read.as_ref().map(|key| key.as_bytes().to_vec()),
            },
        }
    }

    fn key_role(&self, value: &str) -> Option<Role> {
        let presented = digest_of(value);
        let mut role = None;
        for (key_role, digest) in &self.digests {
            if constant_time_equal(&presented, digest) {
                role = Some(*key_role);
            }
        }
        role
    }

    pub fn verify(&self, context: &RequestContext) -> Option<Credential> {
        let value = presented_value(context)?;
        if let Some(role) = self.key_role(value) {
            return Some(Credential::Key(role));
        }
        verify_token(value, &self.signing, now_ms() as f64).map(Credential::Token)
    }
}
