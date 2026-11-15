use narsil::Value;

use super::constants::MAX_FILTER_DEPTH;

fn regex_field_in(expression: &Value, depth: usize) -> Option<String> {
    let Value::Object(expression) = expression else {
        return None;
    };
    if depth > MAX_FILTER_DEPTH {
        return None;
    }
    if let Some(Value::Object(fields)) = expression.get("fields") {
        for (path, tests) in fields.iter() {
            if let Value::Object(tests) = tests
                && tests.contains_key("regex")
            {
                return Some(path.clone());
            }
        }
    }
    for clause in ["and", "or"] {
        if let Some(Value::Array(nested)) = expression.get(clause) {
            for child in nested {
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

pub(crate) fn refused_regex(filter: &Value, allow_regex: bool) -> Option<String> {
    if allow_regex {
        return None;
    }
    let path = regex_field_in(filter, 0)?;
    Some(format!(
        "This server refuses every \"regex\" test, because its operator set the allowRegex server option to false. Test field \"{path}\" with \"contains\" or \"wildcard\""
    ))
}
