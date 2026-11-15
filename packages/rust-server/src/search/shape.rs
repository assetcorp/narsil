use narsil::{Map, Value};

use crate::errors::{Outcome, ServerError};

#[derive(Clone, Copy, PartialEq)]
enum Scalar {
    Text,
    Number,
}

struct Branches {
    string: Option<&'static Shape>,
    number: Option<&'static Shape>,
    boolean: Option<&'static Shape>,
    object: Option<&'static Shape>,
    list: Option<&'static Shape>,
}

const NO_BRANCHES: Branches = Branches {
    string: None,
    number: None,
    boolean: None,
    object: None,
    list: None,
};

enum Shape {
    Text,
    Number,
    Flag,
    Choice(&'static [&'static str]),
    Scalars(Scalar, &'static str),
    Items(&'static Shape),
    Object(&'static [(&'static str, Shape)], &'static [&'static str]),
    Record(&'static Shape),
    Either(&'static str, Branches),
    Unchecked,
}

struct Mismatch {
    path: String,
    wanted: String,
    required: bool,
}

const STRINGS: Shape = Shape::Scalars(Scalar::Text, "a list of strings");
const NUMBERS: Shape = Shape::Scalars(Scalar::Number, "a list of numbers");
const SORT_DIRECTION: Shape = Shape::Choice(&["asc", "desc"]);

const QUERY_SHAPE: Shape = Shape::Object(
    &[
        ("term", Shape::Text),
        ("fields", STRINGS),
        ("filters", Shape::Unchecked),
        ("boost", Shape::Record(&Shape::Number)),
        (
            "bm25",
            Shape::Object(
                &[
                    ("k1", Shape::Number),
                    ("b", Shape::Number),
                    (
                        "fields",
                        Shape::Record(&Shape::Object(
                            &[("k1", Shape::Number), ("b", Shape::Number)],
                            &[],
                        )),
                    ),
                ],
                &[],
            ),
        ),
        ("scoring", Shape::Choice(&["local", "dfs", "broadcast"])),
        ("minScore", Shape::Number),
        (
            "termMatch",
            Shape::Either(
                "\"all\", \"any\", or a number",
                Branches {
                    string: Some(&Shape::Choice(&["all", "any"])),
                    number: Some(&Shape::Number),
                    ..NO_BRANCHES
                },
            ),
        ),
        ("tolerance", Shape::Number),
        ("prefixLength", Shape::Number),
        ("prefix", Shape::Flag),
        ("partialWords", Shape::Flag),
        ("exact", Shape::Flag),
        (
            "facets",
            Shape::Record(&Shape::Object(
                &[
                    ("limit", Shape::Number),
                    ("sort", SORT_DIRECTION),
                    (
                        "ranges",
                        Shape::Items(&Shape::Object(
                            &[("from", Shape::Number), ("to", Shape::Number)],
                            &["from", "to"],
                        )),
                    ),
                ],
                &[],
            )),
        ),
        (
            "sort",
            Shape::Either(
                "an object keyed by field name, or a list of fields",
                Branches {
                    object: Some(&Shape::Record(&SORT_DIRECTION)),
                    list: Some(&Shape::Items(&Shape::Object(
                        &[
                            ("field", Shape::Text),
                            ("direction", SORT_DIRECTION),
                            ("mode", Shape::Choice(&["min", "max", "avg", "median"])),
                        ],
                        &["field", "direction"],
                    ))),
                    ..NO_BRANCHES
                },
            ),
        ),
        ("limit", Shape::Number),
        ("offset", Shape::Number),
        ("searchAfter", Shape::Text),
        (
            "highlight",
            Shape::Object(
                &[
                    ("fields", STRINGS),
                    ("preTag", Shape::Text),
                    ("postTag", Shape::Text),
                    ("maxSnippetLength", Shape::Number),
                ],
                &["fields"],
            ),
        ),
        (
            "pinned",
            Shape::Items(&Shape::Object(
                &[("docId", Shape::Text), ("position", Shape::Number)],
                &["docId", "position"],
            )),
        ),
        ("mode", Shape::Choice(&["vector", "hybrid", "fulltext"])),
        (
            "vector",
            Shape::Object(
                &[
                    ("field", Shape::Text),
                    ("value", NUMBERS),
                    ("text", Shape::Text),
                    ("similarity", Shape::Number),
                    (
                        "metric",
                        Shape::Choice(&["cosine", "dotProduct", "euclidean"]),
                    ),
                    ("efSearch", Shape::Number),
                    ("oversample", Shape::Number),
                ],
                &["field"],
            ),
        ),
        (
            "hybrid",
            Shape::Object(
                &[
                    ("strategy", Shape::Choice(&["rrf", "linear"])),
                    ("k", Shape::Number),
                    ("alpha", Shape::Number),
                    ("depth", Shape::Number),
                ],
                &[],
            ),
        ),
        (
            "rerank",
            Shape::Object(
                &[
                    ("adapter", Shape::Text),
                    ("fields", STRINGS),
                    ("query", Shape::Text),
                    ("window", Shape::Number),
                ],
                &["adapter", "fields"],
            ),
        ),
        ("includeScores", Shape::Flag),
        ("includeScoreComponents", Shape::Flag),
        (
            "document",
            Shape::Either(
                "true, false, or an object",
                Branches {
                    boolean: Some(&Shape::Flag),
                    object: Some(&Shape::Object(
                        &[("include", STRINGS), ("exclude", STRINGS)],
                        &[],
                    )),
                    ..NO_BRANCHES
                },
            ),
        ),
        (
            "group",
            Shape::Object(
                &[
                    ("fields", STRINGS),
                    ("limit", Shape::Number),
                    ("maxPerGroup", Shape::Number),
                ],
                &["fields"],
            ),
        ),
    ],
    &[],
);

fn choices(values: &[&str]) -> String {
    let quoted: Vec<String> = values.iter().map(|value| format!("\"{value}\"")).collect();
    match quoted.as_slice() {
        [first, second] => format!("{first} or {second}"),
        [rest @ .., last] => format!("one of {}, or {last}", rest.join(", ")),
        [] => String::new(),
    }
}

fn wanted(shape: &Shape) -> String {
    match shape {
        Shape::Text => "a string".to_string(),
        Shape::Number => "a number".to_string(),
        Shape::Flag => "true or false".to_string(),
        Shape::Choice(values) => choices(values),
        Shape::Scalars(_, wanted) | Shape::Either(wanted, _) => (*wanted).to_string(),
        Shape::Items(_) => "a list".to_string(),
        Shape::Object(..) => "an object".to_string(),
        Shape::Record(_) => "an object keyed by field name".to_string(),
        Shape::Unchecked => "any value".to_string(),
    }
}

fn child(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn mismatch(path: &str, shape: &Shape, required: bool) -> Mismatch {
    Mismatch {
        path: path.to_string(),
        wanted: wanted(shape),
        required,
    }
}

fn walk_object(
    value: Value,
    fields: &[(&str, Shape)],
    required: &[&str],
    shape: &Shape,
    path: &str,
) -> Result<Value, Mismatch> {
    let Value::Object(given) = value else {
        return Err(mismatch(path, shape, false));
    };
    let mut entries: Vec<(String, Value)> = given
        .into_iter()
        .filter(|(_, item)| !item.is_null())
        .collect();
    for (key, field) in fields {
        let Some(place) = entries.iter().position(|(name, _)| name == key) else {
            if required.contains(key) {
                return Err(mismatch(&child(path, key), field, true));
            }
            continue;
        };
        let item = std::mem::replace(&mut entries[place].1, Value::Null);
        entries[place].1 = walk(item, field, &child(path, key))?;
    }
    Ok(Value::Object(entries.into_iter().collect()))
}

fn walk_record(value: Value, item: &Shape, shape: &Shape, path: &str) -> Result<Value, Mismatch> {
    let Value::Object(given) = value else {
        return Err(mismatch(path, shape, false));
    };
    let mut entries = Vec::with_capacity(given.len());
    for (key, entry) in given {
        if entry.is_null() {
            continue;
        }
        let walked = walk(entry, item, &child(path, &key))?;
        entries.push((key, walked));
    }
    Ok(Value::Object(entries.into_iter().collect()))
}

fn walk_items(value: Value, item: &Shape, shape: &Shape, path: &str) -> Result<Value, Mismatch> {
    let Value::Array(given) = value else {
        return Err(mismatch(path, shape, false));
    };
    let mut items = Vec::with_capacity(given.len());
    for (at, entry) in given.into_iter().enumerate() {
        items.push(walk(entry, item, &child(path, &at.to_string()))?);
    }
    Ok(Value::Array(items))
}

fn is_scalar(value: &Value, scalar: Scalar) -> bool {
    match scalar {
        Scalar::Text => matches!(value, Value::String(_)),
        Scalar::Number => matches!(value, Value::Number(_)),
    }
}

fn branch_of(value: &Value, branches: &Branches) -> Option<&'static Shape> {
    match value {
        Value::String(_) => branches.string,
        Value::Number(_) => branches.number,
        Value::Bool(_) => branches.boolean,
        Value::Array(_) => branches.list,
        Value::Object(_) => branches.object,
        _ => None,
    }
}

fn walk(value: Value, shape: &Shape, path: &str) -> Result<Value, Mismatch> {
    let matches = match (shape, &value) {
        (Shape::Text, Value::String(_)) | (Shape::Number, Value::Number(_)) => true,
        (Shape::Flag, Value::Bool(_)) | (Shape::Unchecked, _) => true,
        (Shape::Choice(values), Value::String(text)) => values.contains(&text.as_str()),
        (Shape::Scalars(scalar, _), Value::Array(items)) => {
            items.iter().all(|item| is_scalar(item, *scalar))
        }
        (Shape::Items(item), _) => return walk_items(value, item, shape, path),
        (Shape::Object(fields, required), _) => {
            return walk_object(value, fields, required, shape, path);
        }
        (Shape::Record(item), _) => return walk_record(value, item, shape, path),
        (Shape::Either(_, branches), _) => {
            let Some(branch) = branch_of(&value, branches) else {
                return Err(mismatch(path, shape, false));
            };
            return walk(value, branch, path).map_err(|missed| {
                if missed.path == path {
                    mismatch(path, shape, false)
                } else {
                    missed
                }
            });
        }
        _ => false,
    };
    if matches {
        Ok(value)
    } else {
        Err(mismatch(path, shape, false))
    }
}

pub(crate) fn shaped_query(params: Map) -> Outcome<Map> {
    match walk(Value::Object(params), &QUERY_SHAPE, "") {
        Ok(Value::Object(shaped)) => Ok(shaped),
        Ok(_) => Err(ServerError::internal()),
        Err(missed) => {
            let verb = if missed.required {
                "is required and must be"
            } else {
                "must be"
            };
            Err(ServerError::invalid(format!(
                "Field \"{}\" {verb} {}",
                missed.path, missed.wanted
            )))
        }
    }
}
