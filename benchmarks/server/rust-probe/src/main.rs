mod constants;
mod errors;
mod import;
mod index_config;
mod pool;
mod respond;
mod routes;
mod search;
mod settings;
mod tasks;

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use narsil::{DurabilityConfig, Narsil, NarsilConfig};
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

use crate::constants::SHUTDOWN_DRAIN_MS;
use crate::pool::CpuPool;
use crate::routes::{AppState, router};
use crate::settings::Settings;
use crate::tasks::TaskStore;

fn open_engine(settings: &Settings) -> Result<Narsil, String> {
    let durability = settings
        .durability_dir
        .as_ref()
        .map(|directory| DurabilityConfig {
            directory: Some(directory.clone()),
            ..DurabilityConfig::default()
        });
    Narsil::open(NarsilConfig {
        durability,
        ..NarsilConfig::default()
    })
    .map_err(|error| format!("could not open the engine: {error}"))
}

async fn stop_signal() {
    let terminate = signal(SignalKind::terminate());
    let interrupt = signal(SignalKind::interrupt());
    match (terminate, interrupt) {
        (Ok(mut terminate), Ok(mut interrupt)) => {
            tokio::select! {
                _ = terminate.recv() => {}
                _ = interrupt.recv() => {}
            }
        }
        _ => std::future::pending::<()>().await,
    }
}

async fn serve(state: AppState, address: SocketAddr) -> Result<(), String> {
    let listener = TcpListener::bind(address)
        .await
        .map_err(|error| format!("could not listen on {address}: {error}"))?;
    println!(
        "Narsil Rust probe listening on http://{address} with {} HTTP threads and {} search threads",
        state.settings.http_threads,
        state.pool.threads()
    );
    let (stopped_sender, stopped_receiver) = tokio::sync::oneshot::channel::<()>();
    let app = router(state);
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        stop_signal().await;
        println!("Stop signal received, draining requests");
        let _ = stopped_sender.send(());
    });
    let drained = tokio::spawn(async move { server.await });
    let _ = stopped_receiver.await;
    match tokio::time::timeout(Duration::from_millis(SHUTDOWN_DRAIN_MS), drained).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(format!("the server stopped with an error: {error}")),
        Ok(Err(error)) => Err(format!("the server task failed: {error}")),
        Err(_) => {
            println!("Requests still open after {SHUTDOWN_DRAIN_MS} ms; closing them");
            Ok(())
        }
    }
}

fn run() -> Result<(), String> {
    let settings = Arc::new(Settings::from_env()?);
    let engine = Arc::new(open_engine(&settings)?);
    let pool = Arc::new(CpuPool::new(settings.search_threads)?);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(settings.http_threads)
        .thread_name("narsil-http")
        .enable_all()
        .build()
        .map_err(|error| format!("could not start the HTTP runtime: {error}"))?;
    let state = AppState {
        engine: Arc::clone(&engine),
        pool,
        tasks: Arc::new(TaskStore::new()),
        settings: Arc::clone(&settings),
    };
    let address = SocketAddr::new(settings.host, settings.port);
    let served = runtime.block_on(serve(state, address));
    runtime.shutdown_timeout(Duration::from_millis(SHUTDOWN_DRAIN_MS));
    let closed = engine
        .shutdown()
        .map_err(|error| format!("could not shut the engine down cleanly: {error}"));
    served.and(closed)
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("Narsil Rust probe failed: {message}");
            ExitCode::FAILURE
        }
    }
}
