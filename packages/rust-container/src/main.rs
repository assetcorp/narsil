mod access;
mod adapters;
mod constants;
mod events;
mod outbound;
mod settings;
mod signals;
mod startup;
mod storage;
mod webhooks;

use std::process::ExitCode;
use std::time::Duration;

use constants::{FAILURE_EXIT_CODE, RUNTIME_SHUTDOWN_TIMEOUT_MS};
use events::Output;
use settings::{ContainerSettings, Environment, read_settings};
use signals::StopSignals;
use startup::start_node;

fn failure(output: &Output, line: &str) -> ExitCode {
    output.notice(line);
    ExitCode::from(FAILURE_EXIT_CODE)
}

async fn serve(settings: ContainerSettings, output: Output) -> ExitCode {
    let node = match start_node(&settings, &output).await {
        Ok(node) => node,
        Err(line) => return failure(&output, &line),
    };
    let mut signals = match StopSignals::install() {
        Ok(signals) => signals,
        Err(message) => {
            let _ = node.stop().await;
            return failure(&output, &format!("The startup program failed: {message}"));
        }
    };
    let port = node.listening_port().await.unwrap_or(settings.network.port);
    output.notice(&format!(
        "Narsil serves HTTP on {}:{port}",
        settings.network.host
    ));
    let signal = signals.next().await;
    output.notice(&format!(
        "Received {signal}, shutting the server and the engine down"
    ));
    match node.stop().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => failure(&output, &format!("The shutdown failed: {message}")),
    }
}

fn run(output: &Output) -> ExitCode {
    let settings = match read_settings(&Environment::from_process()) {
        Ok(settings) => settings,
        Err(line) => return failure(output, &line),
    };
    for warning in &settings.warnings {
        output.notice(&format!("Warning: {warning}"));
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => return failure(output, &format!("The startup program failed: {error}")),
    };
    let code = runtime.block_on(serve(settings, output.clone()));
    runtime.shutdown_timeout(Duration::from_millis(RUNTIME_SHUTDOWN_TIMEOUT_MS));
    code
}

fn main() -> ExitCode {
    let output = Output::start();
    let code = run(&output);
    output.finish();
    code
}
