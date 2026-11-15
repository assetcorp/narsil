mod search_support;
mod support;

use narsil::Value;
use narsil_server::ServerOptions;
use search_support::{
    Book, INDEX, Setup, books, error_message, field, ids, items, text, without_elapsed,
};
use support::{Call, ReferenceServer, RustServer, object, parsed, same_status_and_code, send};

const EVERY_WORD: &str = "river stone quiet harbor lantern winter garden signal";

fn path(route: &str) -> String {
    format!("/indexes/{INDEX}/{route}")
}

fn sorted_ids(mut chosen: Vec<Book>, key: impl Fn(&Book) -> f64) -> Vec<String> {
    chosen.sort_by(|left, right| {
        key(left)
            .total_cmp(&key(right))
            .then_with(|| left.id.cmp(&right.id))
    });
    chosen.into_iter().map(|book| book.id).collect()
}

async fn same_answer(rust: u16, reference: u16, route: &str, body: &str) -> Value {
    let target = path(route);
    let call = Call::new("POST", &target).json(&parsed(body));
    let (mine, theirs) = same_status_and_code(rust, reference, &call).await;
    assert_eq!(
        mine.status,
        200,
        "{route} {body} succeeds: {}",
        String::from_utf8_lossy(&mine.body)
    );
    assert_eq!(
        without_elapsed(&mine.json()),
        without_elapsed(&theirs.json()),
        "{route} {body} answers with the body of the TypeScript server"
    );
    mine.json()
}

#[tokio::test(flavor = "multi_thread")]
async fn searches_answer_as_the_typescript_server_and_the_books_say() {
    let setup = Setup {
        books: 80,
        ..Setup::default()
    };
    let rust = setup.rust().await;
    let reference = setup.reference().await;
    let (mine, theirs) = (rust.port, reference.port);

    for body in [
        r#"{"term":"river","limit":20}"#,
        r#"{"term":"stone harbor","fields":["title"],"limit":15,"includeScoreComponents":true}"#,
        r#"{"term":"stone","facets":{"genre":{"limit":10}},"limit":5}"#,
        r#"{"term":"harbor","highlight":{"fields":["title"]},"limit":3}"#,
        r#"{"filters":{"fields":{"genre":{"eq":"science"}}},"group":{"fields":["year"],"maxPerGroup":2,"limit":4},"limit":10}"#,
        r#"{"term":"garden","tolerance":1,"limit":10,"offset":2}"#,
        r#"{"term":"winter","pinned":[{"docId":"book-001","position":0}],"limit":4}"#,
    ] {
        same_answer(mine, theirs, "search", body).await;
        same_answer(mine, theirs, "search/preflight", body).await;
    }

    let streamed = same_answer(
        mine,
        theirs,
        "search",
        &format!(
            r#"{{"term":"{EVERY_WORD}","termMatch":"any","filters":{{"fields":{{"price":{{"gte":10}}}}}},"sort":{{"price":"desc"}},"limit":100}}"#
        ),
    )
    .await;
    let costly: Vec<Book> = books(80)
        .into_iter()
        .filter(|book| book.price >= 10.0)
        .collect();
    assert!(costly.len() > 64, "the answer is long enough to stream");
    assert_eq!(
        ids(&streamed, "hits"),
        sorted_ids(costly.clone(), |book| -book.price),
        "the streamed answer holds every book of at least 10 from the dearest down"
    );
    assert_eq!(
        field(&streamed, "count").as_f64(),
        Some(costly.len() as f64)
    );

    let by_year_page =
        format!(r#"{{"term":"{EVERY_WORD}","termMatch":"any","sort":{{"year":"asc"}},"limit":7}}"#);
    let first = same_answer(mine, theirs, "search", &by_year_page).await;
    let cursor = text(field(&first, "cursor")).to_string();
    assert!(!cursor.is_empty(), "a full page hands out a cursor");
    let next = format!(
        r#"{{"term":"{EVERY_WORD}","termMatch":"any","sort":{{"year":"asc"}},"limit":7,"searchAfter":"{cursor}"}}"#
    );
    let second = same_answer(mine, theirs, "search", &next).await;
    let by_year = sorted_ids(books(80), |book| book.year);
    let pages: Vec<String> = ids(&first, "hits")
        .into_iter()
        .chain(ids(&second, "hits"))
        .collect();
    assert_eq!(
        pages,
        by_year[..14],
        "two pages follow the year order without a gap"
    );

    for body in [
        r#"{"prefix":"riv"}"#,
        r#"{"prefix":"s","limit":3}"#,
        r#"{"prefix":"","limit":-4}"#,
        r#"{"prefix":"zzz"}"#,
    ] {
        same_answer(mine, theirs, "suggest", body).await;
    }

    rust.stop().await;
    reference.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_listing_pages_through_every_book_once() {
    let setup = Setup {
        books: 80,
        ..Setup::default()
    };
    let rust = setup.rust().await;
    let reference = setup.reference().await;
    let (mine, theirs) = (rust.port, reference.port);

    let mut listed = Vec::new();
    let mut body = r#"{"limit":25}"#.to_string();
    loop {
        let page = same_answer(mine, theirs, "documents/_list", &body).await;
        assert_eq!(field(&page, "total").as_f64(), Some(80.0));
        listed.extend(ids(&page, "documents"));
        match field(&page, "cursor") {
            Value::String(cursor) => body = format!(r#"{{"limit":25,"cursor":"{cursor}"}}"#),
            _ => break,
        }
    }
    let mut every: Vec<String> = books(80).into_iter().map(|book| book.id).collect();
    every.sort();
    assert_eq!(listed, every, "the pages hold every book once in ID order");

    let streamed = same_answer(mine, theirs, "documents/_list", r#"{"limit":70}"#).await;
    assert_eq!(ids(&streamed, "documents"), every[..70]);

    let fiction = same_answer(
        mine,
        theirs,
        "documents/_list",
        r#"{"filters":{"fields":{"genre":{"eq":"fiction"}}},"limit":100,"document":{"include":["title"]}}"#,
    )
    .await;
    let wanted: Vec<String> = every
        .iter()
        .filter(|id| {
            books(80)
                .iter()
                .any(|book| &book.id == *id && book.genre == "fiction")
        })
        .cloned()
        .collect();
    assert_eq!(ids(&fiction, "documents"), wanted);
    for listed in items(field(&fiction, "documents")) {
        let document = field(listed, "document");
        assert!(
            field(document, "price").is_null(),
            "the projection keeps the title alone"
        );
    }

    for (sort, oracle) in [
        (
            r#"{"price":"desc"}"#,
            sorted_ids(books(80), |book| -book.price),
        ),
        (
            r#"[{"field":"year","direction":"asc"}]"#,
            sorted_ids(books(80), |book| book.year),
        ),
    ] {
        let mut listed = Vec::new();
        let mut body = format!(r#"{{"limit":9,"sort":{sort}}}"#);
        loop {
            let page = same_answer(mine, theirs, "documents/_list", &body).await;
            listed.extend(ids(&page, "documents"));
            match field(&page, "cursor") {
                Value::String(cursor) => {
                    body = format!(r#"{{"limit":9,"sort":{sort},"cursor":"{cursor}"}}"#)
                }
                _ => break,
            }
        }
        assert_eq!(
            listed, oracle,
            "a listing sorted by {sort} holds every book once in that order"
        );
    }

    let unsorted = same_answer(mine, theirs, "documents/_list", r#"{"limit":3}"#).await;
    let cursor = text(field(&unsorted, "cursor")).to_string();
    for body in [
        format!(r#"{{"sort":{{"price":"asc"}},"cursor":"{cursor}"}}"#),
        r#"{"sort":{"title":"asc"}}"#.to_string(),
        r#"{"filters":null}"#.to_string(),
    ] {
        let target = path("documents/_list");
        let call = Call::new("POST", &target).json(&parsed(&body));
        let (refused, _) = same_status_and_code(mine, theirs, &call).await;
        assert_eq!(refused.status, 400, "{body} is refused");
    }

    rust.stop().await;
    reference.stop().await;
}

struct Refusal {
    route: &'static str,
    index: &'static str,
    body: &'static str,
}

const fn refusal(route: &'static str, body: &'static str) -> Refusal {
    Refusal {
        route,
        index: INDEX,
        body,
    }
}

const SAME_MESSAGE: &[Refusal] = &[
    refusal("search", ""),
    refusal("search", "{"),
    refusal("search", r#"{"limit":51}"#),
    refusal("search", r#"{"offset":51}"#),
    refusal("search", r#"{"group":{"fields":["genre"],"reduce":{}}}"#),
    refusal("search", r#"{"group":[]}"#),
    refusal(
        "search",
        r#"{"rerank":{"adapter":"stand-in","fields":["title"],"window":21}}"#,
    ),
    refusal(
        "search",
        r#"{"group":{"fields":["genre"],"maxPerGroup":51}}"#,
    ),
    refusal("search", r#"{"facets":{"genre":{"limit":51}}}"#),
    refusal(
        "search",
        r#"{"filters":{"fields":{"title":{"regex":"riv.*"}}}}"#,
    ),
    refusal(
        "search",
        r#"{"filters":{"or":[{"not":{"fields":{"tags":{"regex":"a"}}}}]}}"#,
    ),
    refusal("search/preflight", r#"{"limit":51}"#),
    refusal(
        "search/preflight",
        r#"{"filters":{"fields":{"title":{"regex":"x"}}}}"#,
    ),
    refusal("search", r#"{"term":"river","tolerance":11}"#),
    refusal("search", r#"{"mode":"sideways"}"#),
    refusal("search", r#"{"searchAfter":"not-a-cursor"}"#),
    refusal("suggest", "{}"),
    refusal("suggest", "[]"),
    refusal("suggest", r#"{"prefix":5}"#),
    refusal("documents/_list", r#"{"limit":"5"}"#),
    refusal("documents/_list", r#"{"cursor":5}"#),
    refusal("documents/_list", r#"{"sort":[{}]}"#),
    refusal("documents/_list", r#"{"sort":{"year":"up"}}"#),
    refusal("documents/_list", r#"{"sort":[1,2,3,4,5,6,7,8,9]}"#),
    refusal("documents/_list", "[]"),
    refusal(
        "documents/_list",
        r#"{"filters":{"fields":{"title":{"regex":"a"}}}}"#,
    ),
    Refusal {
        route: "search",
        index: "missing",
        body: r#"{"limit":51}"#,
    },
];

const SAME_CODE: &[Refusal] = &[
    refusal("search", r#"{"vector":{"value":[1,2]}}"#),
    refusal("search", r#"{"term":"river","prefixLength":-1}"#),
    Refusal {
        route: "search",
        index: "missing",
        body: r#"{"term":"river"}"#,
    },
    Refusal {
        route: "search",
        index: "missing",
        body: r#"{"tolerance":11}"#,
    },
    Refusal {
        route: "suggest",
        index: "missing",
        body: r#"{"prefix":"r"}"#,
    },
    Refusal {
        route: "documents/_list",
        index: "missing",
        body: "{}",
    },
];

#[tokio::test(flavor = "multi_thread")]
async fn hostile_reads_are_refused_as_the_typescript_server_refuses_them() {
    let setup = Setup {
        books: 5,
        max_result_window: Some(50),
        max_rerank_window: Some(20),
        refuse_regex: true,
        ..Setup::default()
    };
    let rust = setup.rust().await;
    let reference = setup.reference().await;

    for (cases, same_text) in [(SAME_MESSAGE, true), (SAME_CODE, false)] {
        for case in cases {
            let target = format!("/indexes/{}/{}", case.index, case.route);
            let call = Call::new("POST", &target)
                .header("content-type", "application/json")
                .raw(case.body);
            let (mine, theirs) = same_status_and_code(rust.port, reference.port, &call).await;
            assert!(mine.status >= 400, "{target} {} is refused", case.body);
            if same_text {
                assert_eq!(
                    error_message(&mine.json()),
                    error_message(&theirs.json()),
                    "{target} {} gives the message of the TypeScript server",
                    case.body
                );
            }
        }
    }

    for route in ["search", "search/preflight", "suggest", "documents/_list"] {
        let target = path(route);
        let reply = send(rust.port, &Call::new("POST", &target).raw("null")).await;
        assert!(
            reply.status == 200 || reply.status == 400,
            "{route} answers a null body at once, with {}",
            reply.status
        );
    }

    rust.stop().await;
    reference.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_server_limits_bound_every_page() {
    let setup = Setup {
        books: 30,
        max_result_window: Some(5),
        max_fetch_documents: Some(3),
        ..Setup::default()
    };
    let rust = setup.rust().await;
    let port = rust.port;
    let post = |route: &str, body: &str| {
        let target = path(route);
        let body = body.to_string();
        async move {
            send(
                port,
                &Call::new("POST", &target)
                    .header("content-type", "application/json")
                    .raw(body),
            )
            .await
        }
    };

    let search = post(
        "search",
        r#"{"term":"river stone quiet harbor","termMatch":"any"}"#,
    )
    .await;
    assert_eq!(
        ids(&search.json(), "hits").len(),
        5,
        "a search without a limit stops at the window"
    );
    let grouped = post(
        "search",
        r#"{"group":{"fields":["year"],"maxPerGroup":1},"limit":5}"#,
    )
    .await;
    assert!(items(field(&grouped.json(), "groups")).len() <= 5);

    let listing = post("documents/_list", "{}").await.json();
    assert_eq!(
        ids(&listing, "documents"),
        ["book-000", "book-001", "book-002"]
    );
    assert_eq!(field(&listing, "total").as_f64(), Some(30.0));

    for (route, body, message) in [
        (
            "search",
            r#"{"limit":9007199254740993}"#,
            r#"Field "limit" exceeds the maximum result window of 5"#,
        ),
        (
            "search",
            r#"{"limit":"7"}"#,
            r#"Field "limit" must be a number"#,
        ),
        (
            "search",
            r#"{"limit":6}"#,
            r#"Field "limit" exceeds the maximum result window of 5"#,
        ),
        (
            "search",
            r#"{"facets":{"genre":{"limit":1000000}}}"#,
            r#"Field "facets.genre.limit" exceeds the maximum result window of 5"#,
        ),
        (
            "search",
            r#"{"facets":{"genre":{"limit":1e308}}}"#,
            r#"Field "facets.genre.limit" exceeds the maximum result window of 5"#,
        ),
        (
            "search",
            r#"{"group":{"fields":["year"],"limit":6}}"#,
            r#"Field "group.limit" exceeds the maximum result window of 5"#,
        ),
        (
            "documents/_list",
            r#"{"limit":4}"#,
            r#"Field "limit" exceeds the maximum of 3 documents per request"#,
        ),
        (
            "documents/_list",
            r#"{"limit":1e308}"#,
            r#"Field "limit" exceeds the maximum of 3 documents per request"#,
        ),
    ] {
        let reply = post(route, body).await;
        assert_eq!(
            (
                reply.status,
                reply.error_code().as_deref(),
                error_message(&reply.json())
            ),
            (400, Some("INVALID_REQUEST"), message.to_string()),
            "{route} {body} is refused at the server limit"
        );
    }

    let negative = post("documents/_list", r#"{"limit":-9}"#).await.json();
    assert_eq!(
        ids(&negative, "documents"),
        ["book-000"],
        "a limit below one lists one book"
    );

    rust.stop().await;
}

const NOTES: [(&str, &str); 4] = [
    (
        "a",
        r#"{"title":"zebra harbor 2024","body":"apple stone harbor 7","tag":"harbor"}"#,
    ),
    (
        "b",
        r#"{"title":"apple 7 stone","body":"zebra 2024 harbour","tag":"stone"}"#,
    ),
    (
        "c",
        r#"{"title":"harbor","body":"apple apple zebra","tag":"2024 zebra"}"#,
    ),
    (
        "d",
        r#"{"title":"mango stone","body":"harbor 10 2 zebra","tag":"apple"}"#,
    ),
];

async fn store_notes(port: u16) {
    let created = send(
        port,
        &Call::new("POST", "/indexes").json(&parsed(
            r#"{"name":"notes","config":{"schema":{"title":"string","body":"string","tag":"string"}}}"#,
        )),
    )
    .await;
    assert_eq!(created.status, 201, "the server creates the notes index");
    for (id, fields) in NOTES {
        let target = format!("/indexes/notes/documents/{id}");
        let stored = send(
            port,
            &Call::new("PUT", &target).json(&object(vec![("document", parsed(fields))])),
        )
        .await;
        assert_eq!(stored.status, 201, "the server stores note {id}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn highlights_and_score_components_list_their_keys_in_the_typescript_order() {
    let rust = RustServer::in_memory(ServerOptions::default()).await;
    let reference = ReferenceServer::start(object(vec![])).await;
    store_notes(rust.port).await;
    store_notes(reference.port).await;

    for body in [
        r#"{"term":"zebra apple harbor","includeScoreComponents":true}"#,
        r#"{"term":"10 2 harbor 2024 7","includeScoreComponents":true}"#,
        r#"{"term":"harbr zebr","tolerance":1,"includeScoreComponents":true}"#,
        r#"{"term":"apple stone","fields":["tag","body","title"],"includeScoreComponents":true}"#,
        r#"{"term":"harbor apple zebra","highlight":{"fields":["title","body","tag"]}}"#,
        r#"{"term":"harbor apple zebra","highlight":{"fields":["tag","body","title"]}}"#,
    ] {
        let call = Call::new("POST", "/indexes/notes/search").json(&parsed(body));
        let (mine, theirs) = same_status_and_code(rust.port, reference.port, &call).await;
        assert_eq!(mine.status, 200, "{body} succeeds");
        assert_eq!(
            without_elapsed(&mine.json()),
            without_elapsed(&theirs.json()),
            "{body} lists every key in the order of the TypeScript server"
        );
    }

    reference.stop().await;
    rust.stop().await;
}
