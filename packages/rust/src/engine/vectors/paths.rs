use crate::value::{Map, Value};

const PATH_SEPARATOR: char = '.';

/// Returns the value at a dotted field path, or `None` where a step of the path is absent or holds no object.
pub(crate) fn value_at<'a>(document: &'a Map, path: &str) -> Option<&'a Value> {
    let Some((head, rest)) = path.split_once(PATH_SEPARATOR) else {
        return document.get(path);
    };
    match document.get(head) {
        Some(Value::Object(nested)) => value_at(nested, rest),
        _ => None,
    }
}

/// Sets the value at a dotted field path, replacing with an empty object each step that is absent or holds no
/// object, as every Narsil engine does when it puts a vector back into a document.
pub(crate) fn set_value_at(document: &mut Map, path: &str, value: Value) {
    let Some((head, rest)) = path.split_once(PATH_SEPARATOR) else {
        document.insert(path, value);
        return;
    };
    if !matches!(document.get(head), Some(Value::Object(_))) {
        document.insert(head, Value::Object(Map::new()));
    }
    if let Some(Value::Object(nested)) = document.get_mut(head) {
        set_value_at(nested, rest, value);
    }
}

/// Removes the value at a dotted field path and returns it, leaving every object on the way in place.
pub(crate) fn take_value_at(document: &mut Map, path: &str) -> Option<Value> {
    let Some((head, rest)) = path.split_once(PATH_SEPARATOR) else {
        return document.remove(path);
    };
    match document.get_mut(head) {
        Some(Value::Object(nested)) => take_value_at(nested, rest),
        _ => None,
    }
}
