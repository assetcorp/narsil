use narsil::{ErrorCode, Map, Value};

use super::constants::MAX_FILTER_DEPTH;
use crate::errors::ServerError;

fn regex_field_in(expression: &Value, depth: usize) -> Option<String> {
    let Value::Object(expression) = expression else {
        return None;
    };
    if depth > MAX_FILTER_DEPTH {
        return None;
    }
    if let Some(Value::Object(fields)) = expression.get("fields") {
        for (field_path, filter) in fields.iter() {
            if let Value::Object(filter) = filter
                && filter.contains_key("regex")
            {
                return Some(field_path.clone());
            }
        }
    }
    for nested in [expression.get("and"), expression.get("or")] {
        if let Some(Value::Array(children)) = nested {
            for child in children {
                if let Some(found) = regex_field_in(child, depth + 1) {
                    return Some(found);
                }
            }
        }
    }
    expression
        .get("not")
        .and_then(|negated| regex_field_in(negated, depth + 1))
}

pub(crate) fn refused_regex(filters: Option<&Value>, allow_regex: bool) -> Option<ServerError> {
    if allow_regex {
        return None;
    }
    let field_path = regex_field_in(filters?, 0)?;
    let mut details = Map::with_capacity(3);
    details.insert("fieldPath", Value::String(field_path.clone()));
    details.insert("operator", Value::String("regex".to_string()));
    details.insert("option", Value::String("allowRegex".to_string()));
    Some(
        ServerError::coded(
            ErrorCode::SEARCH_INVALID_FILTER.as_str(),
            format!(
                "This server refuses every \"regex\" test, because its operator set the allowRegex server option to false. Test field \"{field_path}\" with \"contains\" or \"wildcard\""
            ),
        )
        .with_details(details),
    )
}
