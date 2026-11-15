use crate::constants::{
    CORS_PREFLIGHT_MAX_AGE_SECONDS, DEFAULT_CORS_HEADERS, DEFAULT_CORS_METHODS,
};
use crate::http::respond::{HttpResponse, empty, insert_header};
use crate::options::CorsOptions;

pub(crate) struct ResolvedCors {
    origins: Option<Vec<String>>,
    methods: String,
    headers: String,
}

impl ResolvedCors {
    pub(crate) fn of(options: &CorsOptions) -> ResolvedCors {
        ResolvedCors {
            origins: options.origins.clone(),
            methods: options.methods.as_ref().map_or_else(
                || DEFAULT_CORS_METHODS.to_string(),
                |methods| methods.join(", "),
            ),
            headers: options.headers.as_ref().map_or_else(
                || DEFAULT_CORS_HEADERS.to_string(),
                |headers| headers.join(", "),
            ),
        }
    }

    pub(crate) fn origin_headers(&self, request_origin: &str) -> Vec<(&'static str, String)> {
        match &self.origins {
            None => vec![("Access-Control-Allow-Origin", "*".to_string())],
            Some(listed) if listed.iter().any(|origin| origin == request_origin) => vec![
                ("Access-Control-Allow-Origin", request_origin.to_string()),
                ("Vary", "Origin".to_string()),
            ],
            Some(_) => vec![("Vary", "Origin".to_string())],
        }
    }

    pub(crate) fn preflight(&self, request_origin: &str) -> HttpResponse {
        let mut response = empty(204);
        for (name, value) in self.origin_headers(request_origin) {
            insert_header(&mut response, name, &value);
        }
        insert_header(&mut response, "Access-Control-Allow-Methods", &self.methods);
        insert_header(&mut response, "Access-Control-Allow-Headers", &self.headers);
        insert_header(
            &mut response,
            "Access-Control-Max-Age",
            CORS_PREFLIGHT_MAX_AGE_SECONDS,
        );
        response
    }
}
