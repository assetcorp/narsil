mod constants;
mod credentials;
mod routes;
mod token;

use std::sync::Arc;

use narsil_server::{
    BoxError, BoxFuture, QueryIdentify, QueryIdentity, RequestContext, RequestDecision,
    RequestDenial, RequestHook,
};

use constants::{
    GROUP_HEADER, MAX_GROUP_TAIL_CHARACTERS, MAX_PERSON_UTF16_UNITS, PERSON_HEADER, SECONDS_TO_MS,
};
use credentials::Credential;
use routes::route_access_of;
use token::Role;

pub use credentials::CredentialVerifier;

const UNAUTHORIZED_STATUS: u16 = 401;
const FORBIDDEN_STATUS: u16 = 403;

fn denial(status: u16, code: &str, message: &str) -> RequestDecision {
    RequestDecision::Deny(RequestDenial {
        status,
        code: code.to_string(),
        message: message.to_string(),
    })
}

fn unauthorized() -> RequestDecision {
    let message = "This route needs a valid key or token as Authorization: Bearer";
    denial(UNAUTHORIZED_STATUS, "UNAUTHORIZED", message)
}

fn outside_role() -> RequestDecision {
    denial(
        FORBIDDEN_STATUS,
        "FORBIDDEN",
        "This credential grants the read routes alone",
    )
}

fn outside_indexes() -> RequestDecision {
    let message = "This token reaches only the routes of the indexes that it lists";
    denial(FORBIDDEN_STATUS, "FORBIDDEN", message)
}

pub struct AccessHook {
    verifier: Arc<CredentialVerifier>,
}

impl AccessHook {
    pub fn new(verifier: Arc<CredentialVerifier>) -> AccessHook {
        AccessHook { verifier }
    }

    fn decide(&self, context: &RequestContext) -> RequestDecision {
        let route = route_access_of(&context.method, &context.path);
        if route.probe {
            return RequestDecision::Allow;
        }
        let Some(credential) = self.verifier.verify(context) else {
            return unauthorized();
        };
        if credential.role() == Role::Read && !route.read {
            return outside_role();
        }
        let Credential::Token(token) = credential else {
            return RequestDecision::Allow;
        };
        if let Some(indexes) = &token.indexes {
            let listed = route
                .index_name
                .as_ref()
                .is_some_and(|name| indexes.contains(name));
            if !listed {
                return outside_indexes();
            }
        }
        RequestDecision::AllowUntil(token.expires_at_seconds * SECONDS_TO_MS)
    }
}

impl RequestHook for AccessHook {
    fn check(&self, context: RequestContext) -> BoxFuture<Result<RequestDecision, BoxError>> {
        let decision = self.decide(&context);
        Box::pin(async move { Ok(decision) })
    }
}

fn is_group(group: &str) -> bool {
    let mut characters = group.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    let tail: Vec<char> = characters.collect();
    first.is_ascii_alphanumeric()
        && tail.len() <= MAX_GROUP_TAIL_CHARACTERS
        && tail.iter().all(|character| {
            character.is_ascii_alphanumeric() || *character == '_' || *character == '-'
        })
}

fn identity_of(person: Option<&String>, group: Option<&String>) -> Option<QueryIdentity> {
    let (person, group) = (person?, group?);
    let units = person.encode_utf16().count();
    if !(1..=MAX_PERSON_UTF16_UNITS).contains(&units) || !is_group(group) {
        return None;
    }
    Some(QueryIdentity {
        person: Some(person.clone()),
        group: Some(group.clone()),
    })
}

pub struct QueryIdentityOfCredential {
    verifier: Arc<CredentialVerifier>,
}

impl QueryIdentityOfCredential {
    pub fn new(verifier: Arc<CredentialVerifier>) -> QueryIdentityOfCredential {
        QueryIdentityOfCredential { verifier }
    }

    fn identity(&self, context: &RequestContext) -> Option<QueryIdentity> {
        match self.verifier.verify(context)? {
            Credential::Token(token) => identity_of(token.subject.as_ref(), token.group.as_ref()),
            Credential::Key(Role::Admin) => identity_of(
                context.headers.get(PERSON_HEADER),
                context.headers.get(GROUP_HEADER),
            ),
            Credential::Key(Role::Read) => None,
        }
    }
}

impl QueryIdentify for QueryIdentityOfCredential {
    fn identify(
        &self,
        context: RequestContext,
    ) -> BoxFuture<Result<Option<QueryIdentity>, BoxError>> {
        let identity = self.identity(&context);
        Box::pin(async move { Ok(identity) })
    }
}
