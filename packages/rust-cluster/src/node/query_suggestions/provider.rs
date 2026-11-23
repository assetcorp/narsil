use narsil::suggestions_host::SuggestionsService;
use narsil::{
    ManualQuerySuggestion, QuerySuggestionsBuild, QuerySuggestionsPreview, QuerySuggestionsSetting,
    QuerySuggestionsStatus, RecordQueryResult, RecordedQuery,
};

use super::super::handle::ClusterNode;
use crate::data::blocking::off_executor;
use crate::error::ClusterResult;

/// The popular query suggestions of a cluster node, which [`ClusterNode::query_suggestions`] returns.
///
/// The node counts each search that a person follows with a click into its history files, and a build on the node
/// that holds the controller lease merges the history of every node and publishes each phrase that enough people
/// searched into a suggestions index per group, which a prefix search reads.
pub struct ClusterQuerySuggestions<'a> {
    node: &'a ClusterNode,
}

impl ClusterNode {
    /// Returns the popular query suggestions of the node.
    pub fn query_suggestions(&self) -> ClusterQuerySuggestions<'_> {
        ClusterQuerySuggestions { node: self }
    }
}

impl ClusterQuerySuggestions<'_> {
    async fn call<T, F>(&self, index_name: &str, refresh: bool, work: F) -> ClusterResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&SuggestionsService) -> narsil::Result<T> + Send + 'static,
    {
        self.node.guard_shutdown()?;
        let suggestions = &self.node.inner.suggestions;
        let service = suggestions.service()?;
        if refresh {
            suggestions.view.refresh(index_name).await?;
        }
        Ok(off_executor(move || work(&service)).await??)
    }

    /// Counts one search of `index_name` that a person followed with a click, and returns what counting it did.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_NOT_READY` before the node joins, with `NODE_NOT_JOINED` after shutdown, and as
    /// [`narsil::QuerySuggestions::record_query`] does.
    pub async fn record_query(
        &self,
        index_name: &str,
        query: &RecordedQuery,
    ) -> ClusterResult<RecordQueryResult> {
        let refresh = self.node.inner.suggestions.view.get(index_name).is_none();
        let (index, query) = (index_name.to_string(), query.clone());
        self.call(index_name, refresh, move |service| {
            service.record_query(&index, &query)
        })
        .await
    }

    /// Replaces the popular query suggestions setting of `index_name` across the cluster.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterQuerySuggestions::record_query`] does before the call, as
    /// [`narsil::QuerySuggestions::update_setting`] does, and with `CLUSTER_WRITE_BLOCKED` where the metadata of the
    /// index kept changing over 5 attempts.
    pub async fn update_setting(
        &self,
        index_name: &str,
        setting: &QuerySuggestionsSetting,
    ) -> ClusterResult<()> {
        let (index, setting) = (index_name.to_string(), setting.clone());
        self.call(index_name, true, move |service| {
            service.update_setting(&index, &setting)
        })
        .await
    }

    /// Returns the setting, the last build, the next scheduled build, and the suggestions indexes of `index_name`.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterQuerySuggestions::record_query`] does before the call, and with `INDEX_NOT_FOUND` for a
    /// missing index.
    pub async fn status(&self, index_name: &str) -> ClusterResult<QuerySuggestionsStatus> {
        let index = index_name.to_string();
        self.call(index_name, true, move |service| service.status(&index))
            .await
    }

    /// Runs a build of `index_name` on the node that holds the controller lease and returns how it ended, or a
    /// skipped build at once where another build of the index is under way.
    ///
    /// # Errors
    ///
    /// Fails as [`narsil::QuerySuggestions::build`] does, with `NODE_NOT_CONTROLLER` where no node holds the lease,
    /// and with `ALLOCATION_FAILED` where the controller gives up its lease or another build or a drop replaces the
    /// record of the build before it ends.
    pub async fn build(&self, index_name: &str) -> ClusterResult<QuerySuggestionsBuild> {
        let suggestions = &self.node.inner.suggestions;
        suggestions.view.refresh(index_name).await?;
        if !(suggestions.is_controller)() {
            return self.node.request_cluster_build(index_name).await;
        }
        let index = index_name.to_string();
        self.call(index_name, false, move |service| service.build(&index))
            .await
    }

    /// Returns up to `limit` phrases, 100 where `None`, that a build of `index_name` would publish now, most
    /// searched first, without writing anything.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterQuerySuggestions::record_query`] does before the call, and as
    /// [`narsil::QuerySuggestions::preview`] does.
    pub async fn preview(
        &self,
        index_name: &str,
        limit: Option<u32>,
    ) -> ClusterResult<QuerySuggestionsPreview> {
        let index = index_name.to_string();
        self.call(index_name, true, move |service| {
            service.preview(&index, limit)
        })
        .await
    }

    /// Returns the ban list of `index_name`.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterQuerySuggestions::record_query`] does before the call, and with `INDEX_NOT_FOUND` for a
    /// missing index.
    pub async fn bans(&self, index_name: &str) -> ClusterResult<Vec<String>> {
        let index = index_name.to_string();
        self.call(index_name, true, move |service| service.bans(&index))
            .await
    }

    /// Replaces the ban list of `index_name` with `phrases` in normal form, removes each newly banned phrase from
    /// every suggestions index of `index_name`, and returns the stored list.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterQuerySuggestions::update_setting`] does before the change, and as
    /// [`narsil::QuerySuggestions::update_bans`] does.
    pub async fn update_bans(
        &self,
        index_name: &str,
        phrases: &[String],
    ) -> ClusterResult<Vec<String>> {
        let (index, phrases) = (index_name.to_string(), phrases.to_vec());
        self.call(index_name, true, move |service| {
            service.update_bans(&index, &phrases)
        })
        .await
    }

    /// Bans `query` for `index_name` and removes it from every suggestions index of `index_name`, returning the
    /// number of suggestions indexes that held it.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterQuerySuggestions::update_setting`] does before the change, and as
    /// [`narsil::QuerySuggestions::remove_query`] does.
    pub async fn remove_query(&self, index_name: &str, query: &str) -> ClusterResult<u64> {
        let (index, query) = (index_name.to_string(), query.to_string());
        self.call(index_name, true, move |service| {
            service.remove_query(&index, &query)
        })
        .await
    }

    /// Adds a suggestion by hand to the suggestions index of its group, creating that index where it is missing,
    /// and returns the name of that index.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterQuerySuggestions::record_query`] does before the call, and as
    /// [`narsil::QuerySuggestions::add_suggestion`] does.
    pub async fn add_suggestion(
        &self,
        index_name: &str,
        suggestion: &ManualQuerySuggestion,
    ) -> ClusterResult<String> {
        let (index, suggestion) = (index_name.to_string(), suggestion.clone());
        self.call(index_name, true, move |service| {
            service.add_suggestion(&index, &suggestion)
        })
        .await
    }

    /// Returns the name of the suggestions index of `group` for `index_name`.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` for a group outside its format.
    pub async fn suggestions_index_name(
        &self,
        index_name: &str,
        group: &str,
    ) -> ClusterResult<String> {
        let (index, group) = (index_name.to_string(), group.to_string());
        self.call(index_name, false, move |service| {
            service.suggestions_index_name(&index, &group)
        })
        .await
    }
}
