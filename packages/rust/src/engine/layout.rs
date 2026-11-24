use std::ops::Deref;
use std::sync::Arc;

use super::synonyms::SynonymSet;
use crate::analysis::{Analyser, Language};
use crate::index::partition::Partition;

/// The partitions of an index with the analysis that wrote their terms and the synonym set that its searches expand
/// through, which a search reads as one unit so that it matches under one set of settings.
pub(crate) struct TextLayout {
    pub(crate) partitions: Vec<Arc<Partition>>,
    pub(crate) analyser: Analyser,
    pub(crate) synonyms: Arc<SynonymSet>,
    pub(crate) fold_marks: Option<bool>,
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
            fold_marks: self.fold_marks,
        }
    }

    /// Returns a layout that keeps this layout's partitions and analysis with the synonym set `synonyms`.
    pub(crate) fn with_synonyms(&self, synonyms: SynonymSet) -> TextLayout {
        TextLayout {
            partitions: self.partitions.clone(),
            analyser: self.analyser.clone(),
            synonyms: Arc::new(synonyms),
            fold_marks: self.fold_marks,
        }
    }

    /// Returns a layout that keeps this layout's partitions, analysis, and synonyms with the `fold_marks` setting
    /// `fold_marks`, which changes no stored token.
    pub(crate) fn with_fold_marks(&self, fold_marks: Option<bool>) -> TextLayout {
        TextLayout {
            partitions: self.partitions.clone(),
            analyser: self.analyser.clone(),
            synonyms: Arc::clone(&self.synonyms),
            fold_marks,
        }
    }

    /// Returns the language that a search folds by, where the index sets `fold_marks` or, without the setting,
    /// where its language sets folding.
    pub(crate) fn folding_language(&self) -> Option<&Language> {
        let language = self.analyser.language();
        self.fold_marks
            .unwrap_or_else(|| language.folds())
            .then_some(language)
    }
}
