#[cfg(unix)]
pub struct StopSignals {
    terminate: tokio::signal::unix::Signal,
    interrupt: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl StopSignals {
    pub fn install() -> Result<StopSignals, String> {
        use tokio::signal::unix::{SignalKind, signal};
        let installed = |kind: SignalKind| signal(kind).map_err(|failure| failure.to_string());
        Ok(StopSignals {
            terminate: installed(SignalKind::terminate())?,
            interrupt: installed(SignalKind::interrupt())?,
        })
    }

    pub async fn next(&mut self) -> &'static str {
        tokio::select! {
            _ = self.terminate.recv() => "SIGTERM",
            _ = self.interrupt.recv() => "SIGINT",
        }
    }
}

#[cfg(not(unix))]
pub struct StopSignals;

#[cfg(not(unix))]
impl StopSignals {
    pub fn install() -> Result<StopSignals, String> {
        Ok(StopSignals)
    }

    pub async fn next(&mut self) -> &'static str {
        let _ = tokio::signal::ctrl_c().await;
        "SIGINT"
    }
}
