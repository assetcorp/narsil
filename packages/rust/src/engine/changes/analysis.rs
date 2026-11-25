use std::sync::Arc;

use crate::analysis::{Analyser, Language, StopWords};
use crate::config::{
    IndexConfig, StopWordsSetting, TokenizerSetting, require_configuration_within_size_limit,
};
use crate::engine::EngineInner;
use crate::engine::index::IndexState;
use crate::engine::lifecycle::{DEFAULT_LANGUAGE, resolved_analysis};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata::IndexMetadata;
use crate::format::metadata_parts::{NamedAnalysis, PendingAnalysis};
use crate::index::constants::ARRAY_POSITION_GAP;
use crate::schema::BaseType;

/// One analysis setting of an [`AnalysisChange`]: the value that the index holds, the value of its language, or a
/// new value.
#[derive(Clone, Debug, Default)]
pub enum AnalysisSetting<T> {
    /// Keeps the value that the index holds.
    #[default]
    Keep,
    /// Returns to the value that the index's language gives.
    LanguageDefault,
    /// Changes to this value.
    Set(T),
}

/// The analysis settings that [`crate::Narsil::change_analysis`] changes on a live index, where each setting that
/// the change leaves at its default keeps the value that the index holds.
#[derive(Clone, Debug, Default)]
pub struct AnalysisChange {
    /// The name of a language, such as `english`, or `None` to keep the index's language.
    pub language: Option<String>,
    /// The name of a tokenizer that [`crate::Narsil::register_tokenizer`] bound.
    pub tokenizer: AnalysisSetting<String>,
    /// A stop word set that the engine holds by name, or a set of words. A stop word function survives no restart,
    /// so the engine refuses one.
    pub stop_words: AnalysisSetting<StopWordsSetting>,
    /// Whether queries typed without marks also match the words that carry them. A change of this setting alone
    /// switches the index with no rebuild, because folded matching changes no stored token.
    pub fold_marks: AnalysisSetting<bool>,
}

/// The analysis that a change moves an index to: its language, its tokenizer and stop word settings, its
/// `fold_marks` setting, and the analyser that they resolve to.
pub(crate) struct AnalysisTarget {
    pub(crate) language: Language,
    pub(crate) tokenizer: Option<TokenizerSetting>,
    pub(crate) stop_words: Option<StopWordsSetting>,
    pub(crate) fold_marks: Option<bool>,
    pub(crate) analyser: Analyser,
}

pub(crate) fn refused_during_rebalance(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PARTITION_REBALANCING_BACKPRESSURE,
        format!(
            "Index \"{index_name}\" is being rebalanced, so try its analysis change again once the rebalance ends"
        ),
    )
    .with_details([("indexName", crate::value::Value::from(index_name))])
}

fn refused_stop_words(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        format!(
            "The stop words of index \"{index_name}\" must change to a name registered with registerStopWords or to a list of words, because a function survives neither a worker boundary nor a restart"
        ),
    )
    .with_details([("indexName", crate::value::Value::from(index_name))])
}

fn kept<T: Clone>(setting: &AnalysisSetting<T>, current: Option<&T>) -> Option<T> {
    match setting {
        AnalysisSetting::Keep => current.cloned(),
        AnalysisSetting::LanguageDefault => None,
        AnalysisSetting::Set(value) => Some(value.clone()),
    }
}

/// Returns `config` with the language, tokenizer, stop words, and `fold_marks` setting of `target`.
pub(crate) fn config_under(config: &IndexConfig, target: &AnalysisTarget) -> IndexConfig {
    let mut next = config.clone();
    next.language = Some(target.language.name().to_string());
    next.tokenizer = target.tokenizer.clone();
    next.stop_words = target.stop_words.clone();
    next.fold_marks = target.fold_marks;
    next
}

struct TargetSettings {
    tokenizer: Option<TokenizerSetting>,
    stop_words: Option<StopWordsSetting>,
    fold_marks: Option<bool>,
}

fn build_target(
    engine: &EngineInner,
    config: &IndexConfig,
    language: Language,
    settings: TargetSettings,
) -> Result<AnalysisTarget> {
    let mut resolved_config = config.clone();
    resolved_config.tokenizer = settings.tokenizer.clone();
    resolved_config.stop_words = settings.stop_words.clone();
    let analysis = resolved_analysis(engine, &resolved_config)?;
    let analyser = Analyser::new(language.clone(), &analysis)?;
    Ok(AnalysisTarget {
        language,
        tokenizer: settings.tokenizer,
        stop_words: settings.stop_words,
        fold_marks: settings.fold_marks,
        analyser,
    })
}

/// Resolves the analysis that `change` moves `index` to, checking each setting in the order that every Narsil
/// engine checks it.
pub(crate) fn resolve_target(
    engine: &EngineInner,
    index: &IndexState,
    change: &AnalysisChange,
) -> Result<AnalysisTarget> {
    resolve_config_target(engine, &index.name, &index.config(), change)
}

/// Resolves the analysis that `change` moves an index called `index_name` with `config` to, checking each setting
/// in the order that every Narsil engine checks it.
pub(crate) fn resolve_config_target(
    engine: &EngineInner,
    index_name: &str,
    config: &IndexConfig,
    change: &AnalysisChange,
) -> Result<AnalysisTarget> {
    let languages = &engine.settings.languages;
    let language = match &change.language {
        Some(name) => languages.resolve(name)?,
        None => languages.resolve(config.language.as_deref().unwrap_or(DEFAULT_LANGUAGE))?,
    };
    let tokenizer = match &change.tokenizer {
        AnalysisSetting::Keep => config.tokenizer.clone(),
        AnalysisSetting::LanguageDefault => None,
        AnalysisSetting::Set(name) => Some(TokenizerSetting::Named(name.clone())),
    };
    if let AnalysisSetting::Set(StopWordsSetting::Words(StopWords::Function(_))) =
        &change.stop_words
    {
        return Err(refused_stop_words(index_name));
    }
    let stop_words = kept(&change.stop_words, config.stop_words.as_ref());
    let changed = IndexConfig {
        language: Some(language.name().to_string()),
        tokenizer: tokenizer.clone(),
        stop_words: stop_words.clone(),
        ..config.clone()
    };
    require_configuration_within_size_limit(&changed, &language)?;
    let fold_marks = kept(&change.fold_marks, config.fold_marks.as_ref());
    build_target(
        engine,
        config,
        language,
        TargetSettings {
            tokenizer,
            stop_words,
            fold_marks,
        },
    )
}

/// Resolves the analysis that a change recorded as pending moves `index` to.
pub(crate) fn pending_target(
    engine: &EngineInner,
    index: &IndexState,
    pending: &PendingAnalysis,
) -> Result<AnalysisTarget> {
    let language = engine.settings.languages.resolve(&pending.language)?;
    let named = &pending.analysis;
    let tokenizer = named.tokenizer.clone().map(TokenizerSetting::Named);
    let stop_words = match (&named.stop_words, &named.stop_word_list) {
        (Some(name), _) => Some(StopWordsSetting::Named(name.clone())),
        (None, Some(words)) => Some(StopWordsSetting::Words(StopWords::Set(
            words.iter().cloned().collect(),
        ))),
        (None, None) => None,
    };
    build_target(
        engine,
        &index.config(),
        language,
        TargetSettings {
            tokenizer,
            stop_words,
            fold_marks: named.fold_marks,
        },
    )
}

/// Returns the analysis settings that a pending change records for `target`.
pub(crate) fn pending_of(target: &AnalysisTarget, generation: u64) -> PendingAnalysis {
    let mut analysis = NamedAnalysis::default();
    if let Some(TokenizerSetting::Named(name)) = &target.tokenizer {
        analysis.tokenizer = Some(name.clone());
    }
    match &target.stop_words {
        Some(StopWordsSetting::Named(name)) => analysis.stop_words = Some(name.clone()),
        Some(StopWordsSetting::Words(StopWords::Set(words))) => {
            let mut list: Vec<String> = words.iter().cloned().collect();
            list.sort_unstable();
            analysis.stop_word_list = Some(list);
        }
        _ => {}
    }
    analysis.fold_marks = target.fold_marks;
    PendingAnalysis {
        generation,
        language: target.language.name().to_string(),
        analysis,
    }
}

fn same_tokenizer(left: Option<&TokenizerSetting>, right: Option<&TokenizerSetting>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(TokenizerSetting::Named(left)), Some(TokenizerSetting::Named(right))) => {
            left == right
        }
        (Some(TokenizerSetting::Instance(left)), Some(TokenizerSetting::Instance(right))) => {
            Arc::ptr_eq(left, right)
        }
        _ => false,
    }
}

fn same_stop_words(left: Option<&StopWordsSetting>, right: Option<&StopWordsSetting>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(StopWordsSetting::Named(left)), Some(StopWordsSetting::Named(right))) => {
            left == right
        }
        (
            Some(StopWordsSetting::Words(StopWords::Set(left))),
            Some(StopWordsSetting::Words(StopWords::Set(right))),
        ) => left == right,
        (
            Some(StopWordsSetting::Words(StopWords::Function(left))),
            Some(StopWordsSetting::Words(StopWords::Function(right))),
        ) => Arc::ptr_eq(left, right),
        _ => false,
    }
}

/// Reports whether `config` already gives the language, tokenizer, and stop words of `target`.
pub(crate) fn holds_target(config: &IndexConfig, target: &AnalysisTarget) -> bool {
    config.language.as_deref().unwrap_or(DEFAULT_LANGUAGE) == target.language.name()
        && same_tokenizer(config.tokenizer.as_ref(), target.tokenizer.as_ref())
        && same_stop_words(config.stop_words.as_ref(), target.stop_words.as_ref())
}

/// Reports whether `config` already gives the `fold_marks` setting of `target`.
pub(crate) fn holds_fold_marks(config: &IndexConfig, target: &AnalysisTarget) -> bool {
    config.fold_marks == target.fold_marks
}

/// Reports whether the stored terms of `index` came from another analysis than its language module and settings
/// produce now, as `recorded` describes them, which a search reports until the index rebuilds its terms.
pub(crate) fn terms_are_stale(index: &IndexState, recorded: &IndexMetadata) -> bool {
    let revision = index.analyser().language().revision();
    if recorded.analysis_revision.as_deref() != Some(revision) {
        return true;
    }
    recorded.array_position_gap != Some(f64::from(ARRAY_POSITION_GAP))
        && index.config().track_positions != Some(false)
        && index
            .schema
            .fields
            .iter()
            .any(|field| field.field_type.base == BaseType::StringList)
}
