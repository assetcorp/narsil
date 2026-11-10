use super::ast::{END_MASK, Node, Parsed, START_MASK, TRAILING_ESCAPE, failure};

const BACKSLASH: u32 = 0x5c;
const STAR: u32 = 0x2a;
const QUESTION: u32 = 0x3f;

pub(crate) fn parse_wildcard(code_points: &[u32]) -> Parsed<Node> {
    let mut items = vec![Node::Assert(START_MASK)];
    let mut at = 0;
    while at < code_points.len() {
        let code_point = code_points[at];
        match code_point {
            STAR => items.push(Node::Repeat {
                body: Box::new(Node::Any),
                min: 0,
                max: None,
            }),
            QUESTION => items.push(Node::Any),
            BACKSLASH => {
                let Some(&escaped) = code_points.get(at + 1) else {
                    return failure(TRAILING_ESCAPE, at);
                };
                at += 1;
                items.push(Node::Literal(escaped));
            }
            _ => items.push(Node::Literal(code_point)),
        }
        at += 1;
    }
    items.push(Node::Assert(END_MASK));
    Ok(Node::Sequence(items))
}
