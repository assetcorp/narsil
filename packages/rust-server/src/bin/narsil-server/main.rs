use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use narsil::{DurabilityConfig, Narsil, NarsilConfig};
use narsil_server::{
    BoxError, BuildInfo, FeedOptions, NarsilServer, RequestContext, RequestDecision, RequestDenial,
    ServerLimits, ServerOptions,
};

#[cfg(feature = "cluster")]
mod cluster;

#[cfg(not(feature = "cluster"))]
const CLUSTER_ETCD_ENDPOINTS_VARIABLE: &str = "NARSIL_CLUSTER_ETCD_ENDPOINTS";
const DEFAULT_LAUNCHER_PORT: u16 = 7700;
const DEFAULT_LAUNCHER_HOST: &str = "127.0.0.1";
const BEARER_PREFIX: &str = "Bearer ";

fn text_from_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn flag_from_env(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| value == "true")
}

fn number_from_env(name: &str) -> Result<Option<u64>, String> {
    let Some(raw) = std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };
    raw.trim().parse::<u64>().map(Some).map_err(|_| {
        format!("Environment variable {name} must be a non-negative integer, got \"{raw}\"")
    })
}

fn limits_from_env() -> Result<ServerLimits, String> {
    Ok(ServerLimits {
        max_body_bytes: number_from_env("NARSIL_MAX_BODY_BYTES")?,
        max_import_bytes: number_from_env("NARSIL_MAX_IMPORT_BYTES")?,
        max_concurrent_requests: number_from_env("NARSIL_MAX_CONCURRENT")?,
        ..ServerLimits::default()
    })
}

fn presented_key(context: &RequestContext) -> Option<&str> {
    context
        .headers
        .get("authorization")
        .and_then(|header| header.strip_prefix(BEARER_PREFIX))
        .or_else(|| context.headers.get("x-api-key").map(String::as_str))
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

fn api_key_hook(api_key: String) -> ServerOptions {
    let key = Arc::new(api_key);
    let hook = move |context: RequestContext| {
        let key = Arc::clone(&key);
        async move {
            let allowed = presented_key(&context)
                .is_some_and(|presented| constant_time_equal(presented.as_bytes(), key.as_bytes()));
            Ok::<_, BoxError>(if allowed {
                RequestDecision::Allow
            } else {
                RequestDecision::Deny(RequestDenial {
                    status: 401,
                    code: "UNAUTHORIZED".to_string(),
                    message: "A valid API key is required".to_string(),
                })
            })
        }
    };
    ServerOptions {
        on_request: Some(Arc::new(hook)),
        ..ServerOptions::default()
    }
}

fn engine_from_env() -> Result<Narsil, String> {
    let durability = text_from_env("NARSIL_DURABILITY_DIR").map(|directory| DurabilityConfig {
        directory: Some(PathBuf::from(directory)),
        ..DurabilityConfig::default()
    });
    Narsil::open(NarsilConfig {
        durability,
        ..NarsilConfig::default()
    })
    .map_err(|failure| format!("The engine failed to open: {failure}"))
}

fn options_from_env() -> Result<ServerOptions, String> {
    let base = match text_from_env("NARSIL_API_KEY") {
        Some(api_key) => api_key_hook(api_key),
        None => ServerOptions::default(),
    };
    Ok(ServerOptions {
        host: Some(
            text_from_env("NARSIL_HOST").unwrap_or_else(|| DEFAULT_LAUNCHER_HOST.to_string()),
        ),
        port: Some(match number_from_env("NARSIL_PORT")? {
            Some(port) => u16::try_from(port)
                .map_err(|_| format!("NARSIL_PORT must be at most 65535, got {port}"))?,
            None => DEFAULT_LAUNCHER_PORT,
        }),
        allow_insecure: flag_from_env("NARSIL_ALLOW_INSECURE"),
        instance_id: text_from_env("NARSIL_INSTANCE_ID"),
        limits: limits_from_env()?,
        build: BuildInfo {
            version: text_from_env("NARSIL_BUILD_VERSION"),
            git_sha: text_from_env("NARSIL_BUILD_GIT_SHA"),
            dirty: flag_from_env("NARSIL_BUILD_DIRTY"),
        },
        sync: flag_from_env("NARSIL_SYNC").then(FeedOptions::default),
        changes: flag_from_env("NARSIL_CHANGES").then(FeedOptions::default),
        ..base
    })
}

async fn wait_for_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut terminate), Ok(mut interrupt)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) else {
            let _ = tokio::signal::ctrl_c().await;
            return "SIGINT";
        };
        tokio::select! {
            _ = terminate.recv() => "SIGTERM",
            _ = interrupt.recv() => "SIGINT",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        "SIGINT"
    }
}

fn start_failure(failure: impl std::fmt::Display) -> String {
    format!("Narsil HTTP server failed to start: {failure}")
}

#[cfg(feature = "cluster")]
async fn run_cluster(
    launch: cluster::ClusterLaunch,
    options: ServerOptions,
    host: &str,
) -> Result<(), String> {
    let started = launch.start().await?;
    let served = match NarsilServer::cluster(Arc::clone(&started.node), options) {
        Ok(server) => serve(server, host).await,
        Err(failure) => {
            started.node.shutdown().await;
            Err(start_failure(failure))
        }
    };
    started.close().await;
    served
}

async fn run() -> Result<(), String> {
    let options = options_from_env()?;
    let host = options.host.clone().unwrap_or_default();
    #[cfg(feature = "cluster")]
    if let Some(launch) = cluster::ClusterLaunch::from_env()? {
        return run_cluster(launch, options, &host).await;
    }
    #[cfg(not(feature = "cluster"))]
    if text_from_env(CLUSTER_ETCD_ENDPOINTS_VARIABLE).is_some() {
        return Err(format!(
            "{CLUSTER_ETCD_ENDPOINTS_VARIABLE} is set, but this build of the server has no cluster mode; build it with the cluster feature"
        ));
    }
    let engine = Arc::new(engine_from_env()?);
    let server = NarsilServer::new(engine, options).map_err(start_failure)?;
    serve(server, &host).await
}

async fn serve(server: NarsilServer, host: &str) -> Result<(), String> {
    if let Err(failure) = server.listen().await {
        let _ = server.shutdown().await;
        return Err(start_failure(failure));
    }
    let port = server.listening_port().await.unwrap_or(0);
    println!("Narsil HTTP server listening on http://{host}:{port}");
    let signal = wait_for_signal().await;
    println!("Received {signal}, shutting down");
    server.shutdown().await.map_err(|failure| {
        format!("Failed to shut the server and the engine down cleanly: {failure}")
    })
}

fn main() -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(failure) => {
            eprintln!("Narsil HTTP server failed to start: {failure}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
