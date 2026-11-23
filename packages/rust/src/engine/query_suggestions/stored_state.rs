use super::bans::{ban_list_to_wire, stored_ban_list};
use super::setting::{
    KeyCase, setting_from_wire, setting_to_wire, source_from_wire, source_to_wire,
};
use super::types::{QuerySuggestionsSetting, QuerySuggestionsSource};
use crate::error::Result;
use crate::format::metadata::IndexMetadata;
use crate::value::{Map, Value};

const PAYLOAD_SETTING: &str = "querySuggestions";
const PAYLOAD_BANS: &str = "bannedQueries";
const PAYLOAD_SOURCE: &str = "querySuggestionsSource";

/// The popular query suggestion state of one index: its setting, its ban list, and the marker of the index whose
/// suggestions it holds where it is a suggestions index.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SuggestionState {
    pub(crate) setting: Option<QuerySuggestionsSetting>,
    pub(crate) banned: Vec<String>,
    pub(crate) source: Option<QuerySuggestionsSource>,
}

fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

fn stored_state_of(
    setting: Option<&Value>,
    banned: Option<&Value>,
    source: Option<&Value>,
    case: KeyCase,
) -> Result<SuggestionState> {
    Ok(SuggestionState {
        setting: present(setting)
            .map(|raw| setting_from_wire(raw, case))
            .transpose()?,
        banned: present(banned)
            .map(stored_ban_list)
            .transpose()?
            .unwrap_or_default(),
        source: present(source).map(source_from_wire).transpose()?,
    })
}

impl SuggestionState {
    /// Reports whether the setting has the feature on.
    pub fn enabled(&self) -> bool {
        self.setting.as_ref().is_some_and(|setting| setting.enabled)
    }

    /// Returns the setting, or `None` where the index never had one.
    pub fn setting(&self) -> Option<&QuerySuggestionsSetting> {
        self.setting.as_ref()
    }

    /// Returns the ban list.
    pub fn banned(&self) -> &[String] {
        &self.banned
    }

    /// Returns the index and the group whose suggestions the index holds, where it is a suggestions index.
    pub fn source(&self) -> Option<&QuerySuggestionsSource> {
        self.source.as_ref()
    }

    /// Returns the state that the `querySuggestions`, `bannedQueries`, and `querySuggestionsSource` members of the
    /// cluster settings of an index hold.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where a member breaks a rule of its type.
    pub fn from_settings(settings: &Map) -> Result<SuggestionState> {
        SuggestionState::from_payload(settings)
    }

    /// Writes the setting and the ban list into the cluster settings of an index, removing each one that the
    /// state lacks, and leaves the suggestions-index marker of the settings as it is.
    pub fn write_settings(&self, settings: &mut Map) {
        settings.remove(PAYLOAD_SETTING);
        settings.remove(PAYLOAD_BANS);
        if let Some(setting) = &self.setting {
            settings.insert(PAYLOAD_SETTING, setting_to_wire(setting, KeyCase::Camel));
        }
        if !self.banned.is_empty() {
            settings.insert(PAYLOAD_BANS, ban_list_to_wire(&self.banned));
        }
    }

    pub(crate) fn from_metadata(metadata: &IndexMetadata) -> Result<SuggestionState> {
        let banned = metadata.banned_queries.as_deref().map(ban_list_to_wire);
        stored_state_of(
            metadata.query_suggestions.as_ref(),
            banned.as_ref(),
            metadata.query_suggestions_source.as_ref(),
            KeyCase::Snake,
        )
    }

    pub(crate) fn from_payload(payload: &Map) -> Result<SuggestionState> {
        stored_state_of(
            payload.get(PAYLOAD_SETTING),
            payload.get(PAYLOAD_BANS),
            payload.get(PAYLOAD_SOURCE),
            KeyCase::Camel,
        )
    }

    pub(crate) fn write_metadata(&self, metadata: &mut IndexMetadata) {
        metadata.query_suggestions = self
            .setting
            .as_ref()
            .map(|setting| setting_to_wire(setting, KeyCase::Snake));
        metadata.banned_queries = (!self.banned.is_empty()).then(|| self.banned.clone());
        metadata.query_suggestions_source = self.source.as_ref().map(source_to_wire);
    }

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
