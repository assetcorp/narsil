use std::sync::Arc;

use super::constants::DEFAULT_MAX_PER_GROUP;
use super::documents::{LocatedFields, Location};
use super::gather::QueryRun;
use super::params::{GroupConfig, GroupReducer};
use super::ranked::{Ranked, locate_all};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::index::core_values::CoreStoredValues;
use crate::native::status::query_accepted;
use crate::native::workspace::with_workspace;
use crate::search::rankings::id_ranks;
use crate::value::Value;

type GroupValues = Vec<(String, Option<Value>)>;

pub(crate) struct GroupDraft {
    pub(crate) values: GroupValues,
    pub(crate) hits: Vec<Ranked>,
    pub(crate) reduced: Option<Value>,
    pub(crate) reducer_error: Option<String>,
}

struct GroupedFields {
    fields: Vec<Arc<CoreStoredValues>>,
    ordinals: Vec<u32>,
}

struct GroupLimits {
    max_per_group: u32,
    limit: Option<u32>,
}

struct HitGroups {
    heads: Vec<u32>,
    offsets: Vec<u32>,
    positions: Vec<u32>,
}

fn layout_exceeded() -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        "The hit count exceeds the group layout",
    )
}

fn hits_kept_per_group(max_per_group: Option<usize>) -> usize {
    max_per_group
        .filter(|kept| *kept >= 1)
        .unwrap_or(DEFAULT_MAX_PER_GROUP)
}

fn shared_segment(hits: &[Ranked]) -> Option<Location> {
    let first = hits.first()?.location?;
    hits.iter()
        .all(|hit| {
            hit.location.is_some_and(|location| {
                location.partition == first.partition && location.segment == first.segment
            })
        })
        .then_some(first)
}

fn grouped_fields(
    run: &QueryRun<'_>,
    paths: &[&str],
    located: &LocatedFields,
    hits: &[Ranked],
) -> Result<GroupedFields> {
    if let Some(entry) = shared_segment(hits).and_then(|location| run.snapshots.entry(location)) {
        return Ok(GroupedFields {
            fields: paths
                .iter()
                .map(|path| entry.core_stored_values(path))
                .collect::<Result<Vec<Arc<CoreStoredValues>>>>()?,
            ordinals: hits
                .iter()
                .filter_map(|hit| hit.location)
                .map(|location| location.ordinal)
                .collect(),
        });
    }
    let mut fields = vec![CoreStoredValues::default(); paths.len()];
    for hit in hits {
        let readers = hit
            .location
            .and_then(|location| Some((location, located.readers(location)?)));
        for (field, column) in fields.iter_mut().enumerate() {
            let value =
                readers.and_then(|(location, readers)| readers.get(field)?.get(location.ordinal));
            column.push(value.as_deref())?;
        }
    }
    Ok(GroupedFields {
        fields: fields.into_iter().map(Arc::new).collect(),
        ordinals: (0..hits.len() as u32).collect(),
    })
}

fn group_in_core(
    grouped: &GroupedFields,
    scores: &[f64],
    id_ranks: &[u32],
    limits: GroupLimits,
) -> Result<HitGroups> {
    let count = grouped.ordinals.len();
    let views: Vec<ffi::narsil_stored_values> =
        grouped.fields.iter().map(|field| field.view()).collect();
    let mut heads = vec![0u32; count];
    let mut offsets = vec![0u32; count + 1];
    let mut positions = vec![0u32; count];
    let mut members = vec![0u32; count];
    let request = ffi::narsil_group_request {
        values: views.as_ptr(),
        value_count: views.len(),
        ordinals: grouped.ordinals.as_ptr(),
        ordinal_count: grouped.ordinals.len(),
        scores: scores.as_ptr(),
        score_count: scores.len(),
        id_ranks: id_ranks.as_ptr(),
        id_rank_count: id_ranks.len(),
        max_per_group: limits.max_per_group,
        has_limit: u32::from(limits.limit.is_some()),
        limit: limits.limit.unwrap_or(0),
    };
    let mut output = ffi::narsil_group_output {
        heads: heads.as_mut_ptr(),
        head_capacity: heads.len(),
        offsets: offsets.as_mut_ptr(),
        offset_capacity: offsets.len(),
        hits: positions.as_mut_ptr(),
        hit_capacity: positions.len(),
        members: members.as_mut_ptr(),
        member_capacity: members.len(),
        count: 0,
    };
    let status = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_group_hits(workspace, &request, &mut output) })
    })?;
    query_accepted("a grouping of hits", status)?;
    let found = output.count as usize;
    heads.truncate(found);
    offsets.truncate(found + 1);
    Ok(HitGroups {
        heads,
        offsets,
        positions,
    })
}

fn head_values(config: &GroupConfig, located: &LocatedFields, head: &Ranked) -> GroupValues {
    let readers = head
        .location
        .and_then(|location| Some((location, located.readers(location)?)));
    let mut record: GroupValues = Vec::with_capacity(config.fields.len());
    for (field, path) in config.fields.iter().enumerate() {
        if record.iter().any(|(held, _)| held == path) {
            continue;
        }
        let value = readers
            .and_then(|(location, readers)| readers.get(field)?.get(location.ordinal))
            .map(|value| value.into_owned());
        record.push((path.clone(), value));
    }
    record
}

fn fold_reducer<'h>(
    run: &QueryRun<'_>,
    reduce: &GroupReducer,
    hits: impl Iterator<Item = &'h Ranked>,
) -> Result<(Option<Value>, Option<String>)> {
    let mut accumulator = (reduce.initial_value)();
    for hit in hits {
        let Some(document) = run.document(&hit.id, hit.location)? else {
            continue;
        };
        match (reduce.reducer)(accumulator, &document, hit.score) {
            Ok(next) => accumulator = next,
            Err(message) => return Ok((None, Some(message))),
        }
    }
    Ok((Some(accumulator), None))
}

fn limits_of(config: &GroupConfig, count: u32) -> GroupLimits {
    let kept = u32::try_from(hits_kept_per_group(config.max_per_group)).unwrap_or(u32::MAX);
    match config.reduce {
        Some(_) => GroupLimits {
            max_per_group: count,
            limit: None,
        },
        None => GroupLimits {
            max_per_group: kept.min(count),
            limit: config
                .limit
                .map(|limit| u32::try_from(limit).unwrap_or(u32::MAX).min(count)),
        },
    }
}

pub(crate) fn group_hits(
    run: &QueryRun<'_>,
    config: &GroupConfig,
    hits: &mut [Ranked],
) -> Result<Vec<GroupDraft>> {
    if config.fields.is_empty() {
        return Ok(vec![GroupDraft {
            values: Vec::new(),
            hits: hits.to_vec(),
            reduced: None,
            reducer_error: None,
        }]);
    }
    let count = u32::try_from(hits.len()).map_err(|_| layout_exceeded())?;
    locate_all(run, hits)?;
    let paths: Vec<&str> = config.fields.iter().map(String::as_str).collect();
    let located = LocatedFields::of(
        &run.snapshots,
        hits.iter().filter_map(|hit| hit.location),
        &paths,
    )?;
    let grouped = grouped_fields(run, &paths, &located, hits)?;
    let scores: Vec<f64> = hits.iter().map(|hit| hit.score).collect();
    let groups = group_in_core(&grouped, &scores, &id_ranks(hits), limits_of(config, count))?;
    let kept = hits_kept_per_group(config.max_per_group);
    let mut drafts: Vec<GroupDraft> = Vec::with_capacity(groups.heads.len());
    for (at, &head) in groups.heads.iter().enumerate() {
        let members =
            &groups.positions[groups.offsets[at] as usize..groups.offsets[at + 1] as usize];
        let (reduced, reducer_error) = match &config.reduce {
            Some(reduce) => fold_reducer(
                run,
                reduce,
                members.iter().map(|&position| &hits[position as usize]),
            )?,
            None => (None, None),
        };
        drafts.push(GroupDraft {
            values: head_values(config, &located, &hits[head as usize]),
            hits: members
                .iter()
                .take(kept)
                .map(|&position| hits[position as usize].clone())
                .collect(),
            reduced,
            reducer_error,
        });
    }
    if let Some(limit) = config.limit {
        drafts.truncate(limit);
    }
    Ok(drafts)
}
