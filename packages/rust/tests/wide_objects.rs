use std::fmt::Write as _;
use std::io::Write as _;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use narsil::{parse_plain_json, write_plain_json};

const ROUND_TRIP_IN_NODE: &str = "let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => { text += part }); process.stdin.on('end', () => process.stdout.write(JSON.stringify(JSON.parse(text))))";
const WIDE_KEYS: usize = 200_000;
const WIDE_PARSE_DEADLINE: Duration = Duration::from_secs(5);

fn round_trip_in_node(text: &str) -> String {
    let mut child = Command::new("node")
        .arg("-e")
        .arg(ROUND_TRIP_IN_NODE)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("node starts");
    child
        .stdin
        .take()
        .expect("node takes input")
        .write_all(text.as_bytes())
        .expect("node reads the text");
    let output = child.wait_with_output().expect("node finishes");
    assert!(output.status.success(), "node parses the text");
    String::from_utf8(output.stdout).expect("node writes UTF-8")
}

fn round_trip_here(text: &str) -> String {
    write_plain_json(&parse_plain_json(text).expect("the text parses"))
}

fn object_with_repeats_and_index_keys(named: usize, indexed: usize) -> String {
    let mut text = String::from("{");
    for serial in 0..named {
        write!(text, "\"field{}\":{serial},", serial % (named / 2 + 1)).expect("text grows");
        if serial % 7 == 0 {
            let index = (indexed - serial % indexed) * 3;
            write!(text, "\"{index}\":\"at {serial}\",").expect("text grows");
        }
    }
    for serial in (0..indexed).rev() {
        write!(text, "\"{serial}\":{{\"inner{serial}\":[{serial}]}},").expect("text grows");
    }
    text.push_str("\"4294967295\":\"past the largest index\",\"007\":\"padded\",\"\":\"empty\",\"field0\":\"last\"}");
    text
}

#[test]
fn an_object_keeps_the_order_and_the_last_value_that_javascript_gives_its_keys() {
    for (named, indexed) in [(10, 4), (40, 12), (2_000, 500)] {
        let text = object_with_repeats_and_index_keys(named, indexed);
        assert_eq!(
            round_trip_here(&text),
            round_trip_in_node(&text),
            "{named} named keys and {indexed} index keys"
        );
    }
}

#[test]
fn an_object_with_hundreds_of_thousands_of_keys_parses_in_linear_time() {
    let text = object_with_repeats_and_index_keys(WIDE_KEYS, WIDE_KEYS / 2);
    let started = Instant::now();
    let parsed = parse_plain_json(&text).expect("the text parses");
    let took = started.elapsed();
    assert!(took < WIDE_PARSE_DEADLINE, "the parse took {took:?}");
    assert_eq!(write_plain_json(&parsed), round_trip_in_node(&text));
}
