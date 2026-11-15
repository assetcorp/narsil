mod search_support;
mod support;

use narsil::Value;
use search_support::{INDEX, Setup, error_message, field, items, without_elapsed};
use support::{Call, Reply, parsed, same_status_and_code, send};

const VALID_SETTING: &str =
    r#"{"enabled":true,"fields":["title"],"minPeople":2,"minResults":1,"schedule":"off"}"#;

fn route(index: &str, tail: &str) -> String {
    format!("/indexes/{index}/query-suggestions{tail}")
}

struct Pair {
    rust: u16,
    reference: u16,
}

impl Pair {
    async fn both(&self, call: &Call<'_>) -> (Reply, Reply) {
        same_status_and_code(self.rust, self.reference, call).await
    }

    async fn same_body(&self, call: &Call<'_>) -> Value {
        let (mine, theirs) = self.both(call).await;
        assert_eq!(
            without_elapsed(&mine.json()),
            without_elapsed(&theirs.json()),
            "{} {} answers with the body of the TypeScript server",
            call.method,
            call.path
        );
        mine.json()
    }

    async fn same_refusal(&self, call: &Call<'_>) {
        let (mine, theirs) = self.both(call).await;
        assert!(
            mine.status >= 400,
            "{} {} is refused",
            call.method,
            call.path
        );
        assert_eq!(
            error_message(&mine.json()),
            error_message(&theirs.json()),
            "{} {} {} gives the message of the TypeScript server",
            call.method,
            call.path,
            String::from_utf8_lossy(&call.body)
        );
    }
}

fn json_call<'a>(method: &'a str, path: &'a str, body: &'static str) -> Call<'a> {
    Call::new(method, path)
        .header("content-type", "application/json")
        .raw(body)
}

fn search_by<'a>(path: &'a str, person: &str, body: &'static str) -> Call<'a> {
    json_call("POST", path, body).header("x-person", person)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bad_setting_is_refused_before_the_index_is_read() {
    let setup = Setup {
        books: 10,
        suggestions: true,
        ..Setup::default()
    };
    let rust = setup.rust().await;
    let reference = setup.reference().await;
    let pair = Pair {
        rust: rust.port,
        reference: reference.port,
    };
    let books = route(INDEX, "");
    let missing = route("missing", "");

    for body in [
        "",
        "[]",
        "null",
        r#"{"enabled":true,"fields":["title"],"colour":1}"#,
        r#"{"fields":["title"]}"#,
        r#"{"enabled":"yes","fields":["title"]}"#,
        r#"{"enabled":true,"fields":[]}"#,
        r#"{"enabled":true,"fields":"title"}"#,
        r#"{"enabled":true,"fields":["title","title"]}"#,
        r#"{"enabled":true,"fields":["title",""]}"#,
        r#"{"enabled":true,"fields":["title"],"minPeople":2.5}"#,
        r#"{"enabled":true,"fields":["title"],"minPeople":null}"#,
        r#"{"enabled":true,"fields":["title"],"minPeople":1}"#,
        r#"{"enabled":true,"fields":["title"],"minPeople":-5}"#,
        r#"{"enabled":true,"fields":["title"],"minPeople":9007199254740993}"#,
        r#"{"enabled":true,"fields":["title"],"mergeMemoryBytes":1}"#,
        r#"{"enabled":true,"fields":["title"],"maxLength":10,"minLetters":11}"#,
        r#"{"enabled":true,"fields":["title"],"maxPeoplePerDay":100000,"maxPhrasesPerPerson":1000}"#,
        r#"{"enabled":true,"fields":["title"],"schedule":5}"#,
        r#"{"enabled":true,"fields":["title"],"schedule":"every day"}"#,
        r#"{"enabled":true,"fields":["title"],"timeZone":"Mars/Olympus"}"#,
        r#"{"enabled":true,"fields":["title"],"timeZone":null}"#,
        r#"{"enabled":true,"fields":["price"]}"#,
    ] {
        pair.same_refusal(&json_call("PUT", &books, body)).await;
    }
    pair.same_refusal(&json_call("PUT", &missing, r#"{"enabled":true,"fields":[]}"#))
        .await;
    pair.both(&json_call("PUT", &missing, VALID_SETTING)).await;
    pair.both(&Call::new("GET", &missing)).await;

    let status = pair.same_body(&Call::new("GET", &books)).await;
    assert!(field(&status, "setting").is_null(), "a refused setting leaves none behind");
    pair.same_body(&json_call("PUT", &books, VALID_SETTING)).await;
    let status = pair.same_body(&Call::new("GET", &books)).await;
    assert_eq!(
        field(&status, "setting"),
        &parsed(VALID_SETTING),
        "the stored setting is the one that the caller sent"
    );

    rust.stop().await;
    reference.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn searches_count_only_for_the_person_whom_the_server_identifies() {
    let setup = Setup {
        books: 20,
        suggestions: true,
        identify: true,
        ..Setup::default()
    };
    let rust = setup.rust().await;
    let reference = setup.reference().await;
    let pair = Pair {
        rust: rust.port,
        reference: reference.port,
    };
    let record = route(INDEX, "/record");
    let preview = route(INDEX, "/preview");
    pair.same_body(&json_call("PUT", &route(INDEX, ""), VALID_SETTING))
        .await;

    for call in [
        search_by(&record, "alice", r#"{"query":"river stone","person":"mallory"}"#),
        search_by(&record, "alice", r#"{"query":"river stone","group":"admins"}"#),
        search_by(&record, "alice", r#"{}"#),
        search_by(&record, "alice", r#"{"query":7}"#),
        search_by(&record, "alice", "[]"),
        search_by(&record, "alice", ""),
    ] {
        pair.same_refusal(&call).await;
    }
    for mode in ["fail", "half"] {
        let (mine, _) = pair
            .both(&search_by(&record, "alice", r#"{"query":"river stone"}"#).header("x-identify", mode))
            .await;
        assert_eq!(
            (mine.status, mine.error_code().as_deref()),
            (500, Some("HOOK_ERROR"))
        );
    }
    let panicked = send(
        rust.port,
        &search_by(&record, "alice", r#"{"query":"river stone"}"#).header("x-identify", "panic"),
    )
    .await;
    assert_eq!(
        (panicked.status, panicked.error_code().as_deref()),
        (500, Some("HOOK_ERROR")),
        "a panicking identify function answers as a failing one does"
    );

    let anonymous = pair
        .same_body(&json_call("POST", &record, r#"{"query":"river stone"}"#))
        .await;
    assert_eq!(anonymous, parsed(r#"{"recorded":false,"outcome":"unidentified"}"#));
    for (person, outcome) in [("alice", "recorded"), ("alice", "repeat"), ("bob", "recorded")] {
        let answer = pair
            .same_body(&search_by(&record, person, r#"{"query":"River  Stone"}"#))
            .await;
        assert_eq!(field(&answer, "outcome").as_str(), Some(outcome));
    }
    pair.same_body(&search_by(&record, "carol", r#"{"query":"winter harbor"}"#))
        .await;

    let previewed = pair.same_body(&Call::new("GET", &preview)).await;
    let entries = items(field(&previewed, "entries"));
    assert_eq!(entries.len(), 1, "only the phrase that two people searched is ready");
    assert_eq!(field(&entries[0], "query").as_str(), Some("river stone"));
    assert_eq!(field(&entries[0], "count").as_f64(), Some(2.0));
    for limit in ["abc", "0", "-1", "1.5", "12345678", "", "10000001"] {
        let target = format!("{preview}?limit={limit}");
        pair.same_refusal(&Call::new("GET", &target)).await;
    }
    let target = format!("{preview}?limit=1");
    pair.same_body(&Call::new("GET", &target)).await;

    let bans = route(INDEX, "/bans");
    pair.same_body(&Call::new("GET", &bans)).await;
    for body in [r#"{"bans":"river"}"#, r#"{"bans":[1]}"#, r#"{}"#, "[]"] {
        pair.same_refusal(&json_call("PUT", &bans, body)).await;
    }
    pair.same_body(&json_call("PUT", &bans, r#"{"bans":["Quiet  Garden","signal"]}"#))
        .await;
    pair.same_body(&Call::new("GET", &bans)).await;
    let remove = route(INDEX, "/remove");
    pair.same_refusal(&json_call("POST", &remove, r#"{"query":null}"#))
        .await;
    pair.same_body(&json_call("POST", &remove, r#"{"query":"river stone"}"#))
        .await;
    let previewed = pair.same_body(&Call::new("GET", &preview)).await;
    assert!(
        items(field(&previewed, "entries")).is_empty(),
        "a removed phrase leaves the preview"
    );

    let manual = route(INDEX, "/manual");
    for body in [
        r#"{"query":"winter harbor","group":5}"#,
        r#"{"query":"winter harbor","group":"everyone","count":"3"}"#,
        r#"{"query":"winter harbor","group":"everyone","count":null}"#,
        r#"{"query":"winter harbor","group":"everyone","count":-1}"#,
        r#"{"query":"winter harbor","group":"everyone","count":1.5}"#,
        r#"{"query":"winter harbor","group":"everyone","count":5000000000}"#,
        r#"{"query":"winter harbor","group":"no spaces allowed"}"#,
        r#"{"query":"signal","group":"everyone"}"#,
        r#"{"group":"everyone"}"#,
    ] {
        pair.same_refusal(&json_call("POST", &manual, body)).await;
    }
    pair.same_body(&json_call(
        "POST",
        &manual,
        r#"{"query":"winter harbor","group":"everyone","count":3}"#,
    ))
    .await;
    pair.same_refusal(&json_call(
        "POST",
        &route("missing", "/manual"),
        r#"{"query":"winter harbor","group":"everyone"}"#,
    ))
    .await;

    rust.stop().await;
    reference.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_without_an_identify_function_counts_no_search() {
    let setup = Setup {
        books: 5,
        suggestions: true,
        ..Setup::default()
    };
    let rust = setup.rust().await;
    let reference = setup.reference().await;
    let pair = Pair {
        rust: rust.port,
        reference: reference.port,
    };
    pair.same_body(&json_call("PUT", &route(INDEX, ""), VALID_SETTING))
        .await;
    let record = route(INDEX, "/record");
    let (mine, _) = pair
        .both(&search_by(&record, "alice", r#"{"query":"river stone"}"#))
        .await;
    assert_eq!(
        (mine.status, mine.error_code().as_deref()),
        (404, Some("QUERY_SUGGESTIONS_NOT_ENABLED"))
    );
    pair.same_refusal(&search_by(&record, "alice", r#"{"query":"river stone"}"#))
        .await;
    pair.same_refusal(&search_by(&record, "alice", r#"{"query":"river","extra":1}"#))
        .await;

    rust.stop().await;
    reference.stop().await;
}
