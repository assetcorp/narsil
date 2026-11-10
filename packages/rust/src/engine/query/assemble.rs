use std::collections::BTreeMap;

use super::documents::Location;
use super::gather::QueryRun;
use super::grouping::GroupDraft;
use super::projection::{Projection, project_document};
use super::public_components;
use super::ranked::Ranked;
use super::results::{GroupResult, HighlightMatch, Hit};
use crate::error::Result;
use crate::value::Map;

fn projected(
    run: &QueryRun<'_>,
    id: &str,
    location: Option<Location>,
    projection: &Projection,
) -> Result<Option<Map>> {
    if matches!(projection, Projection::Nothing) {
        return Ok(Some(Map::new()));
    }
    Ok(run
        .document(id, location)?
        .map(|document| project_document(&document, projection)))
}

fn reports_scores(run: &QueryRun<'_>) -> bool {
    run.signature.is_none() || run.params.include_scores == Some(true)
}

pub(crate) fn ranked_hit(
    run: &QueryRun<'_>,
    ranked: &Ranked,
    projection: &Projection,
) -> Result<Option<Hit>> {
    let Some(document) = projected(run, &ranked.id, ranked.location, projection)? else {
        return Ok(None);
    };
    let components = match run.params.include_score_components == Some(true) {
        true => ranked.components.clone().map(public_components),
        false => None,
    };
    Ok(Some(Hit {
        id: ranked.id.clone(),
        score: reports_scores(run).then_some(ranked.score),
        document,
        score_components: components,
        highlights: None,
    }))
}

pub(crate) fn sorted_hit(
    run: &QueryRun<'_>,
    id: String,
    location: Location,
    projection: &Projection,
) -> Result<Option<Hit>> {
    let Some(document) = projected(run, &id, Some(location), projection)? else {
        return Ok(None);
    };
    Ok(Some(Hit {
        id,
        score: None,
        document,
        score_components: None,
        highlights: None,
    }))
}

fn organic_highlights<'h>(
    page: &'h [Hit],
    pinned: &[bool],
    id: &str,
) -> Option<&'h BTreeMap<String, HighlightMatch>> {
    page.iter()
        .zip(pinned)
        .find(|(hit, pinned)| !**pinned && hit.id == id)
        .and_then(|(hit, _)| hit.highlights.as_ref())
}

pub(crate) fn assemble_groups(
    run: &QueryRun<'_>,
    groups: Vec<GroupDraft>,
    projection: &Projection,
    page: &[Hit],
    pinned: &[bool],
) -> Result<Vec<GroupResult>> {
    let mut assembled = Vec::with_capacity(groups.len());
    for group in groups {
        let mut hits = Vec::with_capacity(group.hits.len());
        for ranked in &group.hits {
            let Some(mut hit) = ranked_hit(run, ranked, projection)? else {
                continue;
            };
            hit.highlights = organic_highlights(page, pinned, &ranked.id).cloned();
            hits.push(hit);
        }
        assembled.push(GroupResult {
            values: group.values,
            hits,
            reduced: group.reduced,
            reducer_error: group.reducer_error,
        });
    }
    Ok(assembled)
}
