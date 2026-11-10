use super::bans::{ban_list_to_wire, stored_ban_list};
use super::setting::QuerySuggestionsSetting;
use super::setting_wire::{
    KeyCase, QuerySuggestionsSource, setting_from_wire, setting_to_wire, source_from_wire,
    source_to_wire,
};
use crate::error::Result;
use crate::format::metadata::IndexMetadata;
use crate::value::{Map, Value};

const PAYLOAD_SETTING: &str = "querySuggestions";
const PAYLOAD_BANS: &str = "bannedQueries";
const PAYLOAD_SOURCE: &str = "querySuggestionsSource";

/// What an index records about popular query suggestions: its setting, its ban list, and the marker that makes it
/// a suggestions index.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SuggestionState {
    pub(crate) setting: Option<QuerySuggestionsSetting>,
    pub(crate) banned: Vec<String>,
    pub(crate) source: Option<QuerySuggestionsSource>,
}

fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

impl SuggestionState {
    /// Reports whether the index records nothing, which a file leaves out.
    pub(crate) fn is_empty(&self) -> bool {
        self.setting.is_none() && self.banned.is_empty() && self.source.is_none()
    }

    /// Reports whether the setting turns the feature on.
    pub(crate) fn enabled(&self) -> bool {
        self.setting.as_ref().is_some_and(|setting| setting.enabled)
    }

    /// Reads the state that the index metadata holds, refusing a field that breaks a rule with `CONFIG_INVALID`.
    pub(crate) fn from_metadata(metadata: &IndexMetadata) -> Result<SuggestionState> {
        let setting = present(metadata.query_suggestions.as_ref())
            .map(|raw| setting_from_wire(raw, KeyCase::Snake))
            .transpose()?;
        let banned = match &metadata.banned_queries {
            Some(list) => stored_ban_list(&ban_list_to_wire(list))?,
            None => Vec::new(),
        };
        let source = present(metadata.query_suggestions_source.as_ref())
            .map(source_from_wire)
            .transpose()?;
        Ok(SuggestionState {
            setting,
            banned,
            source,
        })
    }

    /// Reads the state that an index configuration payload holds, refusing a field that breaks a rule with
    /// `CONFIG_INVALID`.
    pub(crate) fn from_payload(payload: &Map) -> Result<SuggestionState> {
        let setting = present(payload.get(PAYLOAD_SETTING))
            .map(|raw| setting_from_wire(raw, KeyCase::Camel))
            .transpose()?;
        let banned = match present(payload.get(PAYLOAD_BANS)) {
            Some(raw) => stored_ban_list(raw)?,
            None => Vec::new(),
        };
        let source = present(payload.get(PAYLOAD_SOURCE))
            .map(source_from_wire)
            .transpose()?;
        Ok(SuggestionState {
            setting,
            banned,
            source,
        })
    }

    /// Writes the state into the index metadata, leaving each field absent where the index has none.
    pub(crate) fn write_metadata(&self, metadata: &mut IndexMetadata) {
        metadata.query_suggestions = self
            .setting
            .as_ref()
            .map(|setting| setting_to_wire(setting, KeyCase::Snake));
        metadata.banned_queries = (!self.banned.is_empty()).then(|| self.banned.clone());
        metadata.query_suggestions_source = self.source.as_ref().map(source_to_wire);
    }

    /// Writes the state into an index configuration payload, leaving each field absent where the index has none.
    pub(crate) fn write_payload(&self, payload: &mut Map) {
        if let Some(setting) = &self.setting {
            payload.insert(PAYLOAD_SETTING, setting_to_wire(setting, KeyCase::Camel));
        }
        if !self.banned.is_empty() {
            payload.insert(PAYLOAD_BANS, ban_list_to_wire(&self.banned));
        }
        if let Some(source) = &self.source {
            payload.insert(PAYLOAD_SOURCE, source_to_wire(source));
        }
    }
}
