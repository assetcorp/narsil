use std::cmp::Ordering;

use super::constants::SYNC_BACKUPS_KEPT;
use super::store::{BackupStore, read_every_readable_manifest};
use crate::error::ClusterResult;

pub(crate) fn surplus_taken_backups(
    store: &BackupStore,
    index_name: &str,
    taken_by: &str,
) -> ClusterResult<Vec<String>> {
    let mut taken: Vec<_> = read_every_readable_manifest(store)?
        .into_iter()
        .filter(|manifest| {
            manifest.index_name == index_name && manifest.taken_by.as_deref() == Some(taken_by)
        })
        .collect();
    taken.sort_by(|a, b| {
        b.completed_at
            .partial_cmp(&a.completed_at)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                b.started_at
                    .partial_cmp(&a.started_at)
                    .unwrap_or(Ordering::Equal)
            })
    });
    Ok(taken
        .into_iter()
        .skip(SYNC_BACKUPS_KEPT)
        .map(|manifest| manifest.name)
        .collect())
}
