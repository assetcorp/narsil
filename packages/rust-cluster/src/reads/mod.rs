mod analysis_view;
mod bm25;
mod bm25_view;
mod counts;
mod every_copy;
mod generation_routing;
mod groups;
mod index_list;
pub(crate) mod list;
pub(crate) mod node_messaging;
mod pinned;
pub(crate) mod preflight;
mod projection;
pub(crate) mod query_conversion;
mod ranked_documents;
mod rerank;
mod routable_allocation;
mod scatter;
mod search;
mod terms;
mod vector_reads;

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;

use narsil::{DocumentProjection, Map};

pub(crate) use self::analysis_view::AnalysisView;
use self::bm25_view::Bm25View;
pub use self::counts::{ClusterIndexStats, ClusterPartitionStats};
pub(crate) use self::counts::{count_cluster, partition_stats_cluster, stats_cluster};
pub(crate) use self::generation_routing::read_following_the_name;
pub(crate) use self::index_list::list_indexes_cluster;
pub(crate) use self::list::list_cluster;
use self::node_messaging::{CopyRead, read_documents_from_copies};
pub(crate) use self::preflight::preflight_cluster;
use self::projection::{
    apply_projection, fetch_fields_for, keeps_any_vector_field, resolve_projection,
};
use self::routable_allocation::routable_allocation;
pub(crate) use self::search::query_cluster;
pub(crate) use self::terms::suggest_cluster;
pub(crate) use self::vector_reads::VectorReadView;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::{AllocationView, LocalReads};
use crate::error::ClusterResult;
use crate::node::{ClusterQueryConfig, NodeErrorHandler};
use crate::transport::NodeTransport;

pub(crate) struct ReadDeps {
    pub(crate) node_id: String,
    pub(crate) coordinator: Arc<EtcdCoordinator>,
    pub(crate) transport: Arc<dyn NodeTransport>,
    pub(crate) view: Arc<AllocationView>,
    pub(crate) local: Option<Arc<LocalReads>>,
    pub(crate) query: ClusterQueryConfig,
    pub(crate) analysis_view: AnalysisView,
    pub(crate) bm25_view: Bm25View,
    pub(crate) vector_reads: VectorReadView,
}

pub(crate) struct ReadSettings {
    pub(crate) node_id: String,
    pub(crate) coordinator: Arc<EtcdCoordinator>,
    pub(crate) transport: Arc<dyn NodeTransport>,
    pub(crate) view: Arc<AllocationView>,
    pub(crate) local: Option<Arc<LocalReads>>,
    pub(crate) query: ClusterQueryConfig,
    pub(crate) on_error: Option<NodeErrorHandler>,
}

impl ReadDeps {
    pub(crate) async fn start(settings: ReadSettings) -> ClusterResult<Arc<ReadDeps>> {
        let deps = Arc::new(ReadDeps {
            node_id: settings.node_id,
            analysis_view: AnalysisView::new(
                Arc::clone(&settings.coordinator),
                settings.on_error.clone(),
            ),
            bm25_view: Bm25View::new(Arc::clone(&settings.coordinator), settings.on_error.clone()),
            vector_reads: VectorReadView::new(Arc::clone(&settings.coordinator), settings.on_error),
            coordinator: settings.coordinator,
            transport: settings.transport,
            view: settings.view,
            local: settings.local,
            query: settings.query,
        });
        let started = async {
            deps.analysis_view.start().await?;
            deps.bm25_view.start().await?;
            deps.vector_reads.start().await
        }
        .await;
        if let Err(error) = started {
            deps.stop();
            return Err(error);
        }
        Ok(deps)
    }

    pub(crate) fn stop(&self) {
        self.analysis_view.stop();
        self.bm25_view.stop();
        self.vector_reads.stop();
    }
}

pub(crate) async fn rerun_on_newer_generation<T, F, Fut>(
    deps: &ReadDeps,
    index_name: &str,
    mut run: F,
) -> ClusterResult<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ClusterResult<T>>,
{
    match run().await {
        Err(error) if analysis_view::generation_missing(&error) => {
            deps.analysis_view.refresh(index_name).await?;
            run().await
        }
        outcome => outcome,
    }
}

pub(crate) async fn read_cluster_documents(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    document_ids: &[String],
    projection: Option<&DocumentProjection>,
) -> ClusterResult<BTreeMap<String, Map>> {
    let table = routable_allocation(deps, index_name).await?;
    let settings = deps.vector_reads.settings_of(index_name, &table).await?;
    let projection = resolve_projection(projection, &settings);
    let found = read_documents_from_copies(
        deps,
        index_name,
        document_ids,
        &table,
        CopyRead {
            fields: fetch_fields_for(&projection),
            vectors: keeps_any_vector_field(&projection, &settings),
        },
        true,
        true,
    )
    .await
    .map_err(|failure| failure.error)?;
    Ok(found
        .into_iter()
        .map(|(document_id, document)| (document_id, apply_projection(document, &projection)))
        .collect())
}
