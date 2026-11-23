use narsil::{Map, Value};

fn copy_path(from: &Map, into: &mut Map, path: &[&str]) {
    let Some((first, rest)) = path.split_first() else {
        return;
    };
    let Some(value) = from.get(first) else {
        return;
    };
    if rest.is_empty() {
        into.insert(*first, value.clone());
        return;
    }
    let Value::Object(nested) = value else {
        return;
    };
    if !matches!(into.get(first), Some(Value::Object(_))) {
        into.insert(*first, Value::Object(Map::new()));
    }
    if let Some(Value::Object(target)) = into.get_mut(first) {
        copy_path(nested, target, rest);
    }
}

pub(super) fn kept_fields(document: &Map, fields: &[String]) -> Map {
    let mut kept = Map::new();
    for field in fields {
        let path: Vec<&str> = field.split('.').collect();
        copy_path(document, &mut kept, &path);
    }
    kept
}

fn remove_path(document: &mut Map, path: &[&str]) {
    let Some((first, rest)) = path.split_first() else {
        return;
    };
    if rest.is_empty() {
        document.remove(first);
        return;
    }
    if let Some(Value::Object(nested)) = document.get_mut(first) {
        remove_path(nested, rest);
    }
}

pub(super) fn without_paths(mut document: Map, paths: &[String]) -> Map {
    for path in paths {
        let segments: Vec<&str> = path.split('.').collect();
        remove_path(&mut document, &segments);
    }
    document
}
