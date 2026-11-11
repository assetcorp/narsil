use std::ops::Deref;
use std::sync::Arc;

use super::synonyms::SynonymSet;
use crate::analysis::Analyser;
use crate::index::partition::Partition;

/// The partitions of an index with the analysis that wrote their terms and the synonym set that its searches expand
/// through, which a search reads as one unit so that it matches under one set of settings.
pub(crate) struct TextLayout {
    pub(crate) partitions: Vec<Arc<Partition>>,
    pub(crate) analyser: Analyser,
    pub(crate) synonyms: Arc<SynonymSet>,
}

impl Deref for TextLayout {
    type Target = Vec<Arc<Partition>>;

    fn deref(&self) -> &Vec<Arc<Partition>> {
        &self.partitions
    }
}

impl TextLayout {
    /// Returns a layout that keeps this layout's analysis and synonyms over `partitions`.
    pub(crate) fn with_partitions(&self, partitions: Vec<Arc<Partition>>) -> TextLayout {
        TextLayout {
            partitions,
            analyser: self.analyser.clone(),
            synonyms: Arc::clone(&self.synonyms),
        }
    }

    /// Returns a layout that keeps this layout's partitions and analysis with the synonym set `synonyms`.
    pub(crate) fn with_synonyms(&self, synonyms: SynonymSet) -> TextLayout {
        TextLayout {
            partitions: self.partitions.clone(),
            analyser: self.analyser.clone(),
            synonyms: Arc::new(synonyms),
        }
    }
}
