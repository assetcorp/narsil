use std::collections::BTreeSet;
use std::path::PathBuf;

use narsil_server::ServerLimits;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CorsOrigins {
    Any,
    List(Vec<String>),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccessKeys {
    pub admin: Option<String>,
    pub read: Option<String>,
}

impl AccessKeys {
    pub fn any(&self) -> bool {
        self.admin.is_some() || self.read.is_some()
    }
}

#[derive(Debug, Clone)]
pub struct NetworkSettings {
    pub host: String,
    pub port: u16,
    pub cors: Option<CorsOrigins>,
    pub allow_insecure: bool,
    pub instance_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageKind {
    Filesystem,
    Memory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurabilityChoice {
    Sync,
    Async,
}

#[derive(Debug, Clone)]
pub struct StorageSettings {
    pub kind: StorageKind,
    pub data_dir: PathBuf,
    pub durability_mode: DurabilityChoice,
}

#[derive(Debug, Clone)]
pub struct EngineSettings {
    pub languages: Vec<String>,
    pub workers: Option<u64>,
    pub promotion_threshold: Option<u64>,
    pub allow_regex: bool,
}

#[derive(Debug, Clone)]
pub struct RemoteEndpoint {
    pub url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub timeout_ms: u64,
    pub max_retries: u64,
}

#[derive(Debug, Clone)]
pub struct EmbedderSetting {
    pub name: String,
    pub endpoint: RemoteEndpoint,
    pub dimensions: u64,
}

#[derive(Debug, Clone)]
pub struct RerankerSetting {
    pub name: String,
    pub endpoint: RemoteEndpoint,
    pub max_documents_per_request: u64,
}

#[derive(Debug, Clone)]
pub struct WebhookSettings {
    pub url: String,
    pub secret: Vec<u8>,
    pub events: Option<BTreeSet<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct BuildSettings {
    pub version: Option<String>,
    pub git_sha: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ContainerSettings {
    pub network: NetworkSettings,
    pub keys: AccessKeys,
    pub storage: StorageSettings,
    pub engine: EngineSettings,
    pub limits: ServerLimits,
    pub embedders: Vec<EmbedderSetting>,
    pub rerankers: Vec<RerankerSetting>,
    pub sync: bool,
    pub changes: bool,
    pub query_suggestions_key: Option<String>,
    pub webhook: Option<WebhookSettings>,
    pub build: BuildSettings,
    pub warnings: Vec<String>,
}
