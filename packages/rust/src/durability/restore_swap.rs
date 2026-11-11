use crate::error::NarsilError;

use super::restore_journal::{RestoreStorage, unique_name};

const RETIRED_INDEX_PREFIX: &str = ".retired-";

/// How a swap of an index's files failed: with the index's files whole in their place, or part-way, when only the
/// restore journal can finish the swap.
pub(crate) enum SwapFailure {
    Untouched(NarsilError),
    Lost(NarsilError),
}

impl SwapFailure {
    pub(crate) fn into_error(self) -> NarsilError {
        match self {
            SwapFailure::Untouched(error) | SwapFailure::Lost(error) => error,
        }
    }
}

fn put_back(
    storage: &dyn RestoreStorage,
    aside: &str,
    index_name: &str,
    error: NarsilError,
) -> SwapFailure {
    match storage.move_tree(aside, index_name) {
        Ok(()) => SwapFailure::Untouched(error),
        Err(_) => SwapFailure::Lost(error),
    }
}

/// Moves the index's directory aside and the staged directory into its place, returning where the index's earlier
/// files went. A failed move puts the index's directory back, so that the index keeps its files in their place.
pub(crate) fn move_trees(
    storage: &dyn RestoreStorage,
    index_name: &str,
    staging: &str,
) -> Result<String, SwapFailure> {
    let aside = unique_name(RETIRED_INDEX_PREFIX, "a retired index directory")
        .map_err(SwapFailure::Untouched)?;
    if let Err(error) = storage.move_tree(index_name, &aside) {
        return Err(put_back(storage, &aside, index_name, error));
    }
    if let Err(error) = storage.move_tree(staging, index_name) {
        return Err(put_back(storage, &aside, index_name, error));
    }
    Ok(aside)
}
