use std::path::PathBuf;
use std::sync::Arc;

use narsil::{
    DurabilityConfig, DurabilityMode, DurabilityTier, ErrorCode, Language, Narsil, NarsilConfig,
    NarsilError, QuerySuggestionsConfig, Value, WorkerConfig,
};
use narsil_server::{
    BuildInfo, CorsOptions, FeedOptions, InMemoryTaskStore, NarsilServer, PersistenceTaskStore,
    QueryIdentify, RequestHook, ServerOptions, TaskStore,
};
use tokio::runtime::Handle;

use crate::access::{AccessHook, CredentialVerifier, QueryIdentityOfCredential};
use crate::adapters::{BuiltAdapters, build_adapters};
use crate::events::{EventSink, Output, TaskEventStore, publish_engine_events};
use crate::outbound::OutboundClient;
use crate::settings::ContainerSettings;
use crate::settings::constants::{INDEXES_FOLDER, MODELS_FOLDER, TASKS_FOLDER, WEBHOOKS_FOLDER};
use crate::settings::types::{CorsOrigins, DurabilityChoice, StorageKind};
use crate::storage::{RecordFolder, reconcile_local_tasks};
use crate::webhooks::{DeliveryStore, Destination, QueueHandle, QueueParts};

pub struct RunningNode {
    server: Arc<NarsilServer>,
    queue: Option<QueueHandle>,
    task_store: Arc<TaskEventStore>,
}

#[derive(Default)]
struct Folders {
    indexes: Option<PathBuf>,
    tasks: Option<PathBuf>,
    webhooks: Option<PathBuf>,
}

fn check_languages(languages: &[String]) -> Result<(), String> {
    match languages.iter().find(|name| Language::named(name).is_err()) {
        Some(name) => Err(format!(
            "NARSIL_LANGUAGES names {name}, and this image holds no module of that name"
        )),
        None => Ok(()),
    }
}

fn prepare_folders(settings: &ContainerSettings) -> Result<Folders, String> {
    if settings.storage.kind == StorageKind::Memory {
        return Ok(Folders::default());
    }
    let root = &settings.storage.data_dir;
    let folders = Folders {
        indexes: Some(root.join(INDEXES_FOLDER)),
        tasks: Some(root.join(TASKS_FOLDER)),
        webhooks: Some(root.join(WEBHOOKS_FOLDER)),
    };
    let every = [&folders.indexes, &folders.tasks, &folders.webhooks];
    for folder in every
        .into_iter()
        .flatten()
        .chain([&root.join(MODELS_FOLDER)])
    {
        if std::fs::create_dir_all(folder).is_err() {
            return Err("NARSIL_DATA_DIR must be a folder that this process can write".to_string());
        }
    }
    Ok(folders)
}

fn cors_of(settings: &ContainerSettings) -> Option<CorsOptions> {
    settings.network.cors.as_ref().map(|cors| match cors {
        CorsOrigins::Any => CorsOptions::default(),
        CorsOrigins::List(origins) => CorsOptions {
            origins: Some(origins.clone()),
            ..CorsOptions::default()
        },
    })
}

fn engine_config(settings: &ContainerSettings, folders: &Folders) -> NarsilConfig {
    let engine = &settings.engine;
    let workers = match engine.workers {
        Some(0) => WorkerConfig {
            enabled: Some(false),
            ..WorkerConfig::default()
        },
        count => WorkerConfig {
            enabled: count.map(|_| true),
            count,
            promotion_threshold: engine.promotion_threshold,
            ..WorkerConfig::default()
        },
    };
    let mode = match settings.storage.durability_mode {
        DurabilityChoice::Sync => DurabilityMode::Sync,
        DurabilityChoice::Async => DurabilityMode::Async,
    };
    NarsilConfig {
        durability: folders.indexes.as_ref().map(|directory| DurabilityConfig {
            tier: Some(DurabilityTier::Wal),
            directory: Some(directory.clone()),
            mode: Some(mode),
            ..DurabilityConfig::default()
        }),
        workers: Some(workers),
        max_rerank_window: settings
            .limits
            .max_rerank_window
            .and_then(|window| usize::try_from(window).ok()),
        query_suggestions: settings.query_suggestions_key.as_ref().map(|key| {
            QuerySuggestionsConfig {
                key: key.as_bytes().to_vec(),
            }
        }),
        languages: Some(engine.languages.clone()),
        ..NarsilConfig::default()
    }
}

fn engine_failure(error: &NarsilError) -> String {
    let detail = |name: &str| {
        error
            .details()
            .and_then(|details| details.get(name))
            .and_then(Value::as_str)
    };
    if error.code() == ErrorCode::LANGUAGE_NOT_SUPPORTED
        && let (Some(index_name), Some(language)) = (detail("indexName"), detail("language"))
    {
        return format!(
            "NARSIL_LANGUAGES must name {language}, because the saved index {index_name} needs it"
        );
    }
    format!("The engine failed to start: {}", error.message())
}

async fn open_engine(
    config: NarsilConfig,
    adapters: BuiltAdapters,
    sink: EventSink,
) -> Result<Narsil, String> {
    let opened = tokio::task::spawn_blocking(move || {
        Narsil::open_with(config, move |engine| {
            for (name, adapter) in adapters.embedding {
                engine.register_embedding_adapter(&name, adapter)?;
            }
            for (name, adapter) in adapters.rerank {
                engine.register_rerank_adapter(&name, adapter)?;
            }
            publish_engine_events(engine, &sink);
            Ok(())
        })
    })
    .await;
    match opened {
        Ok(Ok(engine)) => Ok(engine),
        Ok(Err(error)) => Err(engine_failure(&error)),
        Err(failure) => Err(format!("The engine failed to start: {failure}")),
    }
}

fn task_store_of(folders: &Folders, sink: EventSink) -> Arc<TaskEventStore> {
    let inner: Arc<dyn TaskStore> = match &folders.tasks {
        None => Arc::new(InMemoryTaskStore::default()),
        Some(folder) => Arc::new(PersistenceTaskStore::new(Arc::new(RecordFolder::new(
            folder.clone(),
        )))),
    };
    Arc::new(TaskEventStore::new(inner, sink))
}

fn queue_of(
    settings: &ContainerSettings,
    folders: &Folders,
    client: &OutboundClient,
    output: &Output,
) -> Option<QueueHandle> {
    let webhook = settings.webhook.as_ref()?;
    let store = match &folders.webhooks {
        None => DeliveryStore::memory(),
        Some(folder) => DeliveryStore::persisted(RecordFolder::new(folder.clone())),
    };
    let parts = QueueParts {
        destination: Destination {
            client: client.clone(),
            url: webhook.url.clone(),
            secret: webhook.secret.clone(),
        },
        events: webhook.events.clone(),
        store,
        output: output.clone(),
    };
    Some(QueueHandle::spawn(&Handle::current(), parts))
}

fn server_options(settings: &ContainerSettings, task_store: Arc<TaskEventStore>) -> ServerOptions {
    let verifier = Arc::new(CredentialVerifier::new(&settings.keys));
    let hook = settings
        .keys
        .any()
        .then(|| Arc::new(AccessHook::new(Arc::clone(&verifier))) as Arc<dyn RequestHook>);
    let identify = settings.query_suggestions_key.as_ref().map(|_| {
        Arc::new(QueryIdentityOfCredential::new(Arc::clone(&verifier))) as Arc<dyn QueryIdentify>
    });
    ServerOptions {
        host: Some(settings.network.host.clone()),
        port: Some(settings.network.port),
        cors: cors_of(settings),
        on_request: hook,
        build: BuildInfo {
            version: settings.build.version.clone(),
            git_sha: settings.build.git_sha.clone(),
            dirty: false,
        },
        limits: settings.limits.clone(),
        task_store: Some(task_store),
        instance_id: settings.network.instance_id.clone(),
        allow_insecure: settings.network.allow_insecure,
        allow_regex: Some(settings.engine.allow_regex),
        sync: settings.sync.then(FeedOptions::default),
        changes: settings.changes.then(FeedOptions::default),
        query_suggestions_identify: identify,
        ..ServerOptions::default()
    }
}

async fn serve(
    settings: &ContainerSettings,
    engine: Arc<Narsil>,
    queue: Option<&QueueHandle>,
    task_store: Arc<TaskEventStore>,
) -> Result<NarsilServer, String> {
    let failed = |message: String| format!("The server failed to start: {message}");
    if let Some(queue) = queue {
        queue.start().await;
    }
    reconcile_local_tasks(task_store.as_ref())
        .await
        .map_err(|failure| failed(failure.to_string()))?;
    let server = NarsilServer::new(engine, server_options(settings, task_store))
        .map_err(|error| failed(error.message().to_string()))?;
    server
        .listen()
        .await
        .map_err(|error| failed(error.message().to_string()))?;
    Ok(server)
}

pub async fn start_node(
    settings: &ContainerSettings,
    output: &Output,
) -> Result<RunningNode, String> {
    check_languages(&settings.engine.languages)?;
    let folders = prepare_folders(settings)?;
    let client = OutboundClient::new()?;
    let queue = queue_of(settings, &folders, &client, output);
    let events = settings
        .webhook
        .as_ref()
        .and_then(|webhook| webhook.events.clone());
    let sink = EventSink::new(output.clone(), queue.clone(), events);
    let adapters = build_adapters(
        &Handle::current(),
        &client,
        &settings.embedders,
        &settings.rerankers,
    );
    let opened = open_engine(engine_config(settings, &folders), adapters, sink.clone()).await;
    let engine = match opened {
        Ok(engine) => Arc::new(engine),
        Err(line) => {
            if let Some(queue) = &queue {
                queue.close().await;
            }
            return Err(line);
        }
    };
    let task_store = task_store_of(&folders, sink);
    match serve(
        settings,
        Arc::clone(&engine),
        queue.as_ref(),
        Arc::clone(&task_store),
    )
    .await
    {
        Ok(server) => Ok(RunningNode {
            server: Arc::new(server),
            queue,
            task_store,
        }),
        Err(line) => {
            let _ = tokio::task::spawn_blocking(move || engine.shutdown()).await;
            if let Some(queue) = &queue {
                queue.close().await;
            }
            Err(line)
        }
    }
}

impl RunningNode {
    pub async fn listening_port(&self) -> Option<u16> {
        self.server.listening_port().await
    }

    pub async fn stop(&self) -> Result<(), String> {
        let stopped = self.server.shutdown().await;
        let queue_closed = async {
            if let Some(queue) = &self.queue {
                queue.close().await;
            }
        };
        let _ = tokio::join!(queue_closed, self.task_store.shutdown());
        stopped.map_err(|error| error.message().to_string())
    }
}
