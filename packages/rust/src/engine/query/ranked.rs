use super::documents::{LocatedFields, Location};
use super::gather::QueryRun;
use super::sort_keys::{SortPlan, push_key};
use crate::error::Result;
use crate::ordering::{OwnedSortValue, SortValue};
use crate::search::components::ScoreComponents as SegmentComponents;
use crate::search::keyword::KeywordHit;
use crate::search::rankings::RankedEntry;

#[derive(Clone)]
pub(crate) struct Ranked {
    pub(crate) id: String,
    pub(crate) score: f64,
    pub(crate) components: Option<SegmentComponents>,
    pub(crate) location: Option<Location>,
    pub(crate) pinned: bool,
}

impl Ranked {
    pub(crate) fn from_keyword(hit: KeywordHit, location: Option<Location>) -> Ranked {
        Ranked {
            id: hit.id,
            score: hit.score,
            components: hit.components,
            location,
            pinned: false,
        }
    }
}

impl RankedEntry for Ranked {
    fn ranking_score(&self) -> f64 {
        self.score
    }

    fn ranking_id(&self) -> &str {
        &self.id
    }
}

pub(crate) fn locate_all(run: &QueryRun<'_>, hits: &mut [Ranked]) -> Result<()> {
    for hit in hits.iter_mut() {
        if hit.location.is_none() {
            hit.location = run.locate(&hit.id)?;
        }
    }
    Ok(())
}

pub(crate) fn sort_ranked(
    run: &QueryRun<'_>,
    plan: &SortPlan<'_>,
    mut hits: Vec<Ranked>,
) -> Result<Vec<Ranked>> {
    locate_all(run, &mut hits)?;
    let fields = LocatedFields::of(
        &run.snapshots,
        hits.iter().filter_map(|hit| hit.location),
        &plan.fields,
    )?;
    let width = plan.width();
    let mut keys: Vec<SortValue<'_>> = Vec::with_capacity(hits.len() * width);
    for hit in &hits {
        match hit
            .location
            .and_then(|location| Some((location, fields.readers(location)?)))
        {
            Some((location, readers)) => {
                push_key(&mut keys, readers, &plan.modes, location.ordinal)
            }
            None => keys.extend(std::iter::repeat_n(SortValue::Missing, width)),
        }
    }
    let mut order: Vec<usize> = (0..hits.len()).collect();
    order.sort_by(|&left, &right| {
        plan.compare(
            &keys[left * width..(left + 1) * width],
            &keys[right * width..(right + 1) * width],
        )
        .then_with(|| hits[left].id.cmp(&hits[right].id))
    });
    let mut slots: Vec<Option<Ranked>> = hits.into_iter().map(Some).collect();
    Ok(order
        .into_iter()
        .filter_map(|at| slots[at].take())
        .collect())
}

pub(crate) fn owned_key(
    run: &QueryRun<'_>,
    plan: &SortPlan<'_>,
    location: Option<Location>,
) -> Result<Vec<OwnedSortValue>> {
    let missing = || vec![OwnedSortValue::Missing; plan.width()];
    let Some(location) = location else {
        return Ok(missing());
    };
    let fields = LocatedFields::of(&run.snapshots, std::iter::once(location), &plan.fields)?;
    let Some(readers) = fields.readers(location) else {
        return Ok(missing());
    };
    let mut keys = Vec::with_capacity(plan.width());
    push_key(&mut keys, readers, &plan.modes, location.ordinal);
    Ok(keys.into_iter().map(SortValue::owned).collect())
}
