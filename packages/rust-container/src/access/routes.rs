const NAME: &str = "{name}";

const PROBE_PATHS: [&str; 4] = ["/livez", "/readyz", "/health", "/version"];

const GET_ROUTES_OUTSIDE_READ: [&[&str]; 2] =
    [&["indexes", NAME, "snapshot"], &["indexes", NAME, "export"]];

const POST_READ_ROUTES: [&[&str]; 7] = [
    &["indexes", NAME, "search"],
    &["indexes", NAME, "search", "preflight"],
    &["indexes", NAME, "suggest"],
    &["indexes", NAME, "documents", "_list"],
    &["indexes", NAME, "documents", "_multi-get"],
    &["indexes", NAME, "_wait-for-writes"],
    &["indexes", NAME, "query-suggestions", "record"],
];

pub struct RouteAccess {
    pub probe: bool,
    pub read: bool,
    pub index_name: Option<String>,
}

fn segments_of(path: &str) -> Vec<&str> {
    path.strip_prefix('/').unwrap_or(path).split('/').collect()
}

fn matches(segments: &[&str], pattern: &[&str]) -> bool {
    segments.len() == pattern.len()
        && pattern
            .iter()
            .zip(segments)
            .all(|(part, segment)| *part == NAME || part == segment)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_component(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while let Some(&byte) = bytes.get(at) {
        if byte != b'%' {
            decoded.push(byte);
            at += 1;
            continue;
        }
        let high = hex_value(*bytes.get(at + 1)?)?;
        let low = hex_value(*bytes.get(at + 2)?)?;
        decoded.push(high * 16 + low);
        at += 3;
    }
    String::from_utf8(decoded).ok()
}

fn index_name_of(segments: &[&str]) -> Option<String> {
    match segments {
        ["indexes", name, ..] => decode_component(name),
        _ => None,
    }
}

fn is_read(method: &str, segments: &[&str]) -> bool {
    match method {
        "GET" | "HEAD" => !GET_ROUTES_OUTSIDE_READ
            .iter()
            .any(|pattern| matches(segments, pattern)),
        "POST" => POST_READ_ROUTES
            .iter()
            .any(|pattern| matches(segments, pattern)),
        _ => false,
    }
}

pub fn route_access_of(method: &str, path: &str) -> RouteAccess {
    let verb = method.to_ascii_uppercase();
    let probe = (verb == "GET" || verb == "HEAD") && PROBE_PATHS.contains(&path);
    let segments = segments_of(path);
    RouteAccess {
        probe,
        read: is_read(&verb, &segments),
        index_name: index_name_of(&segments),
    }
}
