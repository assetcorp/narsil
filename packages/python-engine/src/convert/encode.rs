use narsil::{
    AdapterSetting, Bm25Params, DocumentProjection, IndexConfig, QueryParams, ScoringMode,
    SortDirection, SortMode, StopWords, StopWordsSetting, Storage, SynonymRule, TermMatch,
    TokenizerSetting,
};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use super::query::{HYBRID_STRATEGIES, METRICS, SCORING_MODES, SEARCH_MODES, SORT_MODES};
use super::value::value_to_py;
use crate::callbacks::functions::GroupReducerHandle;

fn name_of<T: PartialEq + Copy>(choices: &[(&'static str, T)], wanted: T) -> &'static str {
    choices
        .iter()
        .find(|(_, variant)| *variant == wanted)
        .map(|(name, _)| *name)
        .unwrap_or_default()
}

fn direction(direction: SortDirection) -> &'static str {
    match direction {
        SortDirection::Asc => "asc",
        SortDirection::Desc => "desc",
    }
}

fn set_some<'py, T: IntoPyObject<'py>>(
    dict: &Bound<'py, PyDict>,
    key: &str,
    value: Option<T>,
) -> PyResult<()> {
    match value {
        Some(value) => dict.set_item(key, value),
        None => Ok(()),
    }
}

pub(crate) fn bm25<'py>(py: Python<'py>, params: &Bm25Params) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    set_some(&dict, "k1", params.k1)?;
    set_some(&dict, "b", params.b)?;
    if let Some(fields) = &params.fields {
        let named = PyDict::new(py);
        for (field, pair) in fields {
            let entry = PyDict::new(py);
            set_some(&entry, "k1", pair.k1)?;
            set_some(&entry, "b", pair.b)?;
            named.set_item(field, entry)?;
        }
        dict.set_item("fields", named)?;
    }
    Ok(dict)
}

fn projection<'py>(
    py: Python<'py>,
    projection: &DocumentProjection,
) -> PyResult<Bound<'py, PyAny>> {
    Ok(match projection {
        DocumentProjection::All => true.into_pyobject(py)?.to_owned().into_any(),
        DocumentProjection::None => false.into_pyobject(py)?.to_owned().into_any(),
        DocumentProjection::Fields { include, exclude } => {
            let dict = PyDict::new(py);
            set_some(&dict, "include", include.clone())?;
            set_some(&dict, "exclude", exclude.clone())?;
            dict.into_any()
        }
    })
}

fn sorting<'py>(py: Python<'py>, params: &QueryParams, dict: &Bound<'py, PyDict>) -> PyResult<()> {
    if let Some(sort) = &params.sort {
        let list = PyList::empty(py);
        for field in sort {
            let entry = PyDict::new(py);
            entry.set_item("field", &field.field)?;
            entry.set_item("direction", direction(field.direction))?;
            set_some(
                &entry,
                "mode",
                field.mode.map(|mode: SortMode| name_of(&SORT_MODES, mode)),
            )?;
            list.append(entry)?;
        }
        dict.set_item("sort", list)?;
    }
    if let Some(facets) = &params.facets {
        let fields = PyDict::new(py);
        for (field, spec) in facets {
            let entry = PyDict::new(py);
            set_some(&entry, "limit", spec.limit)?;
            set_some(&entry, "sort", spec.sort.map(direction))?;
            if let Some(ranges) = &spec.ranges {
                let list = PyList::empty(py);
                for (from, to) in ranges {
                    let range = PyDict::new(py);
                    range.set_item("from", from)?;
                    range.set_item("to", to)?;
                    list.append(range)?;
                }
                entry.set_item("ranges", list)?;
            }
            fields.set_item(field, entry)?;
        }
        dict.set_item("facets", fields)?;
    }
    if let Some(group) = &params.group {
        let entry = PyDict::new(py);
        entry.set_item("fields", group.fields.clone())?;
        set_some(&entry, "maxPerGroup", group.max_per_group)?;
        set_some(&entry, "limit", group.limit)?;
        if let Some(reduce) = &group.reduce {
            entry.set_item(
                "reduce",
                GroupReducerHandle {
                    reducer: reduce.clone(),
                },
            )?;
        }
        dict.set_item("group", entry)?;
    }
    Ok(())
}

fn retrieval<'py>(
    py: Python<'py>,
    params: &QueryParams,
    dict: &Bound<'py, PyDict>,
) -> PyResult<()> {
    if let Some(vector) = &params.vector {
        let entry = PyDict::new(py);
        entry.set_item("field", &vector.field)?;
        set_some(&entry, "value", vector.value.clone())?;
        set_some(&entry, "text", vector.text.as_deref())?;
        set_some(&entry, "similarity", vector.similarity)?;
        set_some(
            &entry,
            "metric",
            vector.metric.map(|metric| name_of(&METRICS, metric)),
        )?;
        set_some(&entry, "efSearch", vector.ef_search)?;
        set_some(&entry, "oversample", vector.oversample)?;
        dict.set_item("vector", entry)?;
    }
    if let Some(hybrid) = &params.hybrid {
        let entry = PyDict::new(py);
        set_some(
            &entry,
            "strategy",
            hybrid
                .strategy
                .map(|strategy| name_of(&HYBRID_STRATEGIES, strategy)),
        )?;
        set_some(&entry, "k", hybrid.k)?;
        set_some(&entry, "alpha", hybrid.alpha)?;
        set_some(&entry, "depth", hybrid.depth)?;
        dict.set_item("hybrid", entry)?;
    }
    if let Some(rerank) = &params.rerank {
        let entry = PyDict::new(py);
        entry.set_item("adapter", &rerank.adapter)?;
        entry.set_item("fields", rerank.fields.clone())?;
        set_some(&entry, "query", rerank.query.as_deref())?;
        set_some(&entry, "window", rerank.window)?;
        dict.set_item("rerank", entry)?;
    }
    if let Some(highlight) = &params.highlight {
        let entry = PyDict::new(py);
        entry.set_item("fields", highlight.fields.clone())?;
        set_some(&entry, "preTag", highlight.pre_tag.as_deref())?;
        set_some(&entry, "postTag", highlight.post_tag.as_deref())?;
        set_some(&entry, "maxSnippetLength", highlight.max_snippet_length)?;
        dict.set_item("highlight", entry)?;
    }
    if let Some(pinned) = &params.pinned {
        let list = PyList::empty(py);
        for pin in pinned {
            let entry = PyDict::new(py);
            entry.set_item("docId", &pin.doc_id)?;
            entry.set_item("position", pin.position)?;
            list.append(entry)?;
        }
        dict.set_item("pinned", list)?;
    }
    Ok(())
}

pub(crate) fn query_dict<'py>(
    py: Python<'py>,
    params: &QueryParams,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    set_some(&dict, "term", params.term.as_deref())?;
    set_some(&dict, "fields", params.fields.clone())?;
    if let Some(filters) = &params.filters {
        dict.set_item("filters", value_to_py(py, filters)?)?;
    }
    if let Some(boost) = &params.boost {
        let fields = PyDict::new(py);
        for (field, multiplier) in boost {
            fields.set_item(field, multiplier)?;
        }
        dict.set_item("boost", fields)?;
    }
    if let Some(params_bm25) = &params.bm25 {
        dict.set_item("bm25", bm25(py, params_bm25)?)?;
    }
    set_some(
        &dict,
        "scoring",
        params
            .scoring
            .map(|mode: ScoringMode| name_of(&SCORING_MODES, mode)),
    )?;
    set_some(&dict, "minScore", params.min_score)?;
    if let Some(policy) = params.term_match {
        match policy {
            TermMatch::All => dict.set_item("termMatch", "all")?,
            TermMatch::Any => dict.set_item("termMatch", "any")?,
            TermMatch::AtLeast(count) => dict.set_item("termMatch", count)?,
        }
    }
    set_some(&dict, "tolerance", params.tolerance)?;
    set_some(&dict, "prefixLength", params.prefix_length)?;
    set_some(&dict, "prefix", params.prefix)?;
    set_some(&dict, "partialWords", params.partial_words)?;
    set_some(&dict, "exact", params.exact)?;
    sorting(py, params, &dict)?;
    set_some(&dict, "limit", params.limit)?;
    set_some(&dict, "offset", params.offset)?;
    set_some(&dict, "searchAfter", params.search_after.as_deref())?;
    set_some(
        &dict,
        "mode",
        params.mode.map(|mode| name_of(&SEARCH_MODES, mode)),
    )?;
    retrieval(py, params, &dict)?;
    set_some(&dict, "includeScores", params.include_scores)?;
    set_some(
        &dict,
        "includeScoreComponents",
        params.include_score_components,
    )?;
    if let Some(document) = &params.document {
        dict.set_item("document", projection(py, document)?)?;
    }
    Ok(dict)
}

fn storage_name(storage: Storage) -> &'static str {
    storage.name()
}

pub(crate) fn synonyms<'py>(
    py: Python<'py>,
    rules: &[SynonymRule],
) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for rule in rules {
        let entry = PyDict::new(py);
        match rule {
            SynonymRule::TwoWay(words) => entry.set_item("words", words.clone())?,
            SynonymRule::OneWay { word, synonyms } => {
                entry.set_item("word", word)?;
                entry.set_item("synonyms", synonyms.clone())?;
            }
        }
        list.append(entry)?;
    }
    Ok(list)
}

fn analysis_settings<'py>(
    py: Python<'py>,
    config: &IndexConfig,
    dict: &Bound<'py, PyDict>,
) -> PyResult<()> {
    match &config.tokenizer {
        Some(TokenizerSetting::Named(name)) => dict.set_item("tokenizer", name)?,
        Some(TokenizerSetting::Instance(_)) => dict.set_item("tokenizer", py.None())?,
        None => {}
    }
    match &config.stop_words {
        Some(StopWordsSetting::Named(name)) => dict.set_item("stopWords", name)?,
        Some(StopWordsSetting::Words(StopWords::Set(words))) => {
            let mut sorted: Vec<&String> = words.iter().collect();
            sorted.sort();
            dict.set_item("stopWords", sorted)?;
        }
        Some(_) => dict.set_item("stopWords", py.None())?,
        None => {}
    }
    if let Some(embedding) = &config.embedding {
        let entry = PyDict::new(py);
        let fields = PyDict::new(py);
        for (field, sources) in &embedding.fields {
            fields.set_item(field, sources.clone())?;
        }
        entry.set_item("fields", fields)?;
        match &embedding.adapter {
            Some(AdapterSetting::Named(name)) => entry.set_item("adapter", name)?,
            Some(AdapterSetting::Instance(_)) => entry.set_item("adapter", py.None())?,
            None => {}
        }
        dict.set_item("embedding", entry)?;
    }
    Ok(())
}

pub(crate) fn index_config_dict<'py>(
    py: Python<'py>,
    config: &IndexConfig,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("schema", value_to_py(py, &config.schema)?)?;
    set_some(&dict, "language", config.language.as_deref())?;
    if let Some(partitions) = &config.partitions {
        let entry = PyDict::new(py);
        set_some(
            &entry,
            "maxDocsPerPartition",
            partitions.max_docs_per_partition,
        )?;
        set_some(&entry, "maxPartitions", partitions.max_partitions)?;
        set_some(&entry, "watermark", partitions.watermark)?;
        dict.set_item("partitions", entry)?;
    }
    set_some(
        &dict,
        "defaultScoring",
        config
            .default_scoring
            .map(|mode| name_of(&SCORING_MODES, mode)),
    )?;
    if let Some(params) = &config.bm25 {
        dict.set_item("bm25", bm25(py, params)?)?;
    }
    analysis_settings(py, config, &dict)?;
    set_some(&dict, "trackPositions", config.track_positions)?;
    set_some(&dict, "textStorage", config.text_storage.map(storage_name))?;
    if let Some(promotion) = &config.vector_promotion {
        let entry = PyDict::new(py);
        set_some(&entry, "threshold", promotion.threshold)?;
        set_some(&entry, "filterThreshold", promotion.filter_threshold)?;
        if let Some(hnsw) = &promotion.hnsw {
            let graph = PyDict::new(py);
            set_some(&graph, "m", hnsw.m)?;
            set_some(&graph, "efConstruction", hnsw.ef_construction)?;
            set_some(
                &graph,
                "metric",
                hnsw.metric.map(|metric| name_of(&METRICS, metric)),
            )?;
            entry.set_item("hnswConfig", graph)?;
        }
        set_some(
            &entry,
            "quantization",
            promotion.quantization.map(|mode| mode.name()),
        )?;
        set_some(&entry, "storage", promotion.storage.map(storage_name))?;
        dict.set_item("vectorPromotion", entry)?;
    }
    set_some(&dict, "strict", config.strict)?;
    set_some(&dict, "required", config.required.clone())?;
    set_some(&dict, "surfaceForms", config.surface_forms)?;
    set_some(&dict, "patternValueLimit", config.pattern_value_limit)?;
    if let Some(rules) = &config.synonyms {
        dict.set_item("synonyms", synonyms(py, rules)?)?;
    }
    Ok(dict)
}
