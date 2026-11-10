use crate::config::{Bm25FieldParams, Bm25Params};

fn sets_value(params: &Bm25Params) -> bool {
    if params.k1.is_some() || params.b.is_some() {
        return true;
    }
    params.fields.as_ref().is_some_and(|fields| {
        fields
            .iter()
            .any(|(_, pair)| pair.k1.is_some() || pair.b.is_some())
    })
}

fn field_of<'a>(params: Option<&'a Bm25Params>, name: &str) -> Option<&'a Bm25FieldParams> {
    params?
        .fields
        .as_ref()?
        .iter()
        .find(|(field, _)| field == name)
        .map(|(_, pair)| pair)
}

/// Returns the BM25 parameters that a search scores with: the search's own values over the index's, field by field.
pub(crate) fn merged_bm25(search: Option<&Bm25Params>, index: Option<&Bm25Params>) -> Bm25Params {
    let Some(search) = search.filter(|search| sets_value(search)) else {
        return index.cloned().unwrap_or_default();
    };
    let mut merged = Bm25Params {
        k1: search.k1.or(index.and_then(|index| index.k1)),
        b: search.b.or(index.and_then(|index| index.b)),
        fields: None,
    };
    let mut names: Vec<&str> = Vec::new();
    for params in [Some(search), index].into_iter().flatten() {
        for (name, _) in params.fields.iter().flatten() {
            if !names.contains(&name.as_str()) {
                names.push(name);
            }
        }
    }
    if names.is_empty() {
        return merged;
    }
    let fields = names
        .into_iter()
        .map(|name| {
            let from_search = field_of(Some(search), name);
            let from_index = field_of(index, name);
            let pair = Bm25FieldParams {
                k1: from_search
                    .and_then(|pair| pair.k1)
                    .or(search.k1)
                    .or(from_index.and_then(|pair| pair.k1)),
                b: from_search
                    .and_then(|pair| pair.b)
                    .or(search.b)
                    .or(from_index.and_then(|pair| pair.b)),
            };
            (name.to_string(), pair)
        })
        .collect();
    merged.fields = Some(fields);
    merged
}
