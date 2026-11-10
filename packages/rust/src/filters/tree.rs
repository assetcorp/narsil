use crate::schema::{BaseType, CompiledSchema};
use crate::value::{Map, Value};

pub(super) struct FieldNode {
    pub(super) path: String,
    pub(super) base: BaseType,
    pub(super) pattern: bool,
    pub(super) tests: Map,
}

#[derive(Default)]
pub(super) struct FilterNode {
    pub(super) fields: Vec<FieldNode>,
    pub(super) and: Vec<FilterNode>,
    pub(super) or: Vec<FilterNode>,
    pub(super) not: Option<Box<FilterNode>>,
}

fn nested(expression: &Map, clause: &str, schema: &CompiledSchema) -> Vec<FilterNode> {
    match expression.get(clause) {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|nested| match nested {
                Value::Object(nested) => Some(filter_tree(nested, schema)),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

pub(super) fn filter_tree(expression: &Map, schema: &CompiledSchema) -> FilterNode {
    let mut node = FilterNode::default();
    if let Some(Value::Object(fields)) = expression.get("fields") {
        for (path, tests) in fields.iter() {
            let (Some(field), Value::Object(tests)) = (schema.field(path), tests) else {
                continue;
            };
            node.fields.push(FieldNode {
                path: path.clone(),
                base: field.field_type.base,
                pattern: field.field_type.pattern,
                tests: tests.clone(),
            });
        }
    }
    node.and = nested(expression, "and", schema);
    node.or = nested(expression, "or", schema);
    if let Some(Value::Object(not)) = expression.get("not") {
        node.not = Some(Box::new(filter_tree(not, schema)));
    }
    node
}
