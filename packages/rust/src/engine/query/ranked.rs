use super::documents::Location;
use super::gather::QueryRun;
use super::sort_keys::{LocatedValues, SortPlan, located_key};
use crate::error::Result;
use crate::ordering::{KeyBatch, OwnedSortValue};
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
    let mut batch = KeyBatch::new(plan.width());
    let mut located = LocatedValues::new(&run.snapshots);
    for hit in &hits {
        located.push_key(plan, hit.location, &mut batch)?;
    }
    let ranked = batch.ranked()?;
    let mut order: Vec<usize> = (0..hits.len()).collect();
    order.sort_by(|&left, &right| {
        ranked
            .compare(left, right, &plan.directions)
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
    located_key(&run.snapshots, plan, location)
}
