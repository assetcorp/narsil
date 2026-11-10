use super::types::QuerySuggestionsWarningReason;
use crate::engine::EngineInner;
use crate::engine::events::NarsilEvent;

/// Raises a warning about the popular query suggestions of `index_name` to every listener of warnings.
pub(crate) fn warn(
    engine: &EngineInner,
    index_name: &str,
    reason: QuerySuggestionsWarningReason,
    file: Option<String>,
    message: Option<String>,
) {
    engine.events.emit(NarsilEvent::QuerySuggestionsWarning {
        index_name: index_name.to_string(),
        reason,
        file,
        message,
    });
}
