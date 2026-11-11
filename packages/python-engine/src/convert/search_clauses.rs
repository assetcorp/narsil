use narsil::{ErrorCode, HybridConfig, NarsilError, RerankConfig, VectorQuery};

use super::fields::{Fields, floats_of, string_of};
use super::query::{HYBRID_STRATEGIES, METRICS};
use crate::errors::recoded;

pub(super) fn vector(mut fields: Fields<'_>) -> Result<VectorQuery, NarsilError> {
    fields.refuse_none("field", ErrorCode::SEARCH_INVALID_FIELD)?;
    let field = fields
        .string("field")
        .map_err(recoded(ErrorCode::SEARCH_INVALID_FIELD))?
        .ok_or_else(|| {
            NarsilError::new(
                ErrorCode::SEARCH_INVALID_MODE,
                format!("{} is required", fields.path("field")),
            )
        })?;
    let value_path = fields.path("value");
    let text_path = fields.path("text");
    let value = fields.present("value")?;
    let text = fields.present("text")?;
    if value.is_some() && text.is_some() {
        return Err(NarsilError::new(
            ErrorCode::EMBEDDING_CONFIG_INVALID,
            "Vector query cannot have both 'text' and 'value'",
        ));
    }
    let value = value
        .map(|value| floats_of(&value, &value_path))
        .transpose()
        .map_err(recoded(ErrorCode::DOC_VALIDATION_FAILED))?;
    let text = text
        .map(|text| string_of(&text, &text_path))
        .transpose()
        .map_err(recoded(ErrorCode::DOC_VALIDATION_FAILED))?;
    fields.refuse_each_none(&["efSearch", "oversample"], ErrorCode::CONFIG_INVALID)?;
    let query = VectorQuery {
        field,
        value,
        text,
        similarity: fields.number("similarity")?,
        metric: fields.choice("metric", &METRICS)?,
        ef_search: fields.whole_u32("efSearch")?,
        oversample: fields.number("oversample")?,
    };
    fields.finish()?;
    Ok(query)
}

pub(super) fn hybrid(mut fields: Fields<'_>) -> Result<HybridConfig, NarsilError> {
    let config = HybridConfig {
        strategy: fields.choice("strategy", &HYBRID_STRATEGIES)?,
        k: fields.number("k")?,
        alpha: fields.number("alpha")?,
        depth: fields.size("depth")?,
    };
    fields.finish()?;
    Ok(config)
}

pub(super) fn rerank(mut fields: Fields<'_>, label: &str) -> Result<RerankConfig, NarsilError> {
    let refused = recoded(ErrorCode::RERANK_CONFIG_INVALID);
    fields.refuse_each_none(&["query", "window"], ErrorCode::RERANK_CONFIG_INVALID)?;
    let config = RerankConfig {
        adapter: fields.required_string("adapter").map_err(&refused)?,
        fields: fields.strings("fields").map_err(&refused)?.ok_or_else(|| {
            NarsilError::new(
                ErrorCode::RERANK_CONFIG_INVALID,
                format!("{label}.fields is required"),
            )
        })?,
        query: fields.string("query").map_err(&refused)?,
        window: fields.size("window").map_err(&refused)?,
    };
    fields.finish()?;
    Ok(config)
}
