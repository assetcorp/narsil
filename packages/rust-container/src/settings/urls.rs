use http::Uri;

pub struct HttpUrl {
    pub scheme: String,
    pub authority: String,
    pub path_and_query: String,
    pub has_user_info: bool,
    pub has_query: bool,
    pub has_fragment: bool,
    pub default_port: bool,
}

impl HttpUrl {
    pub fn without_fragment(&self) -> String {
        format!(
            "{}://{}{}",
            self.scheme, self.authority, self.path_and_query
        )
    }
}

pub fn parse_http_url(raw: &str) -> Option<HttpUrl> {
    let (before_fragment, has_fragment) = match raw.split_once('#') {
        Some((before, _)) => (before, true),
        None => (raw, false),
    };
    let uri = Uri::try_from(before_fragment).ok()?;
    let scheme = uri.scheme_str()?.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = uri.authority()?;
    if authority.host().is_empty() {
        return None;
    }
    let path = match uri.path() {
        "" => "/",
        path => path,
    };
    let path_and_query = match uri.query() {
        Some(query) => format!("{path}?{query}"),
        None => path.to_string(),
    };
    let default_port = matches!(
        (scheme.as_str(), authority.port_u16()),
        ("http", Some(80)) | ("https", Some(443))
    );
    Some(HttpUrl {
        has_user_info: authority.as_str().contains('@'),
        has_query: before_fragment.contains('?'),
        authority: authority.as_str().to_string(),
        scheme,
        path_and_query,
        has_fragment,
        default_port,
    })
}
