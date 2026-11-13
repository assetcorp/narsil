use std::net::IpAddr;
use std::num::NonZeroUsize;
use std::path::PathBuf;

use crate::constants::{
    DEFAULT_HOST, DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_IMPORT_BYTES, DEFAULT_PORT,
};

#[derive(Debug, Clone)]
pub struct BuildInfo {
    pub version: Option<String>,
    pub git_sha: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub host: IpAddr,
    pub port: u16,
    pub durability_dir: Option<PathBuf>,
    pub max_body_bytes: usize,
    pub max_import_bytes: usize,
    pub http_threads: usize,
    pub search_threads: usize,
    pub build: BuildInfo,
}

fn text_from_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn count_from_env(name: &str) -> Result<Option<usize>, String> {
    let Some(raw) = text_from_env(name) else {
        return Ok(None);
    };
    raw.trim()
        .parse::<usize>()
        .map(Some)
        .map_err(|_| format!("{name} must be a non-negative integer, got \"{raw}\""))
}

fn thread_count_from_env(name: &str, default: usize) -> Result<usize, String> {
    match count_from_env(name)? {
        None | Some(0) => Ok(default),
        Some(count) => Ok(count),
    }
}

pub fn available_cores() -> usize {
    std::thread::available_parallelism()
        .map(NonZeroUsize::get)
        .unwrap_or(1)
}

impl Settings {
    pub fn from_env() -> Result<Settings, String> {
        let host_text = text_from_env("NARSIL_HOST").unwrap_or_else(|| DEFAULT_HOST.to_owned());
        let host: IpAddr = host_text
            .parse()
            .map_err(|_| format!("NARSIL_HOST must be an IP address, got \"{host_text}\""))?;
        let allow_insecure = text_from_env("NARSIL_ALLOW_INSECURE").as_deref() == Some("true");
        if !host.is_loopback() && !allow_insecure {
            return Err(format!(
                "Refusing to listen on {host} without authentication; set NARSIL_ALLOW_INSECURE=true to serve a private network"
            ));
        }
        let port = match count_from_env("NARSIL_PORT")? {
            None => DEFAULT_PORT,
            Some(port) => {
                u16::try_from(port).map_err(|_| format!("NARSIL_PORT {port} is above 65535"))?
            }
        };
        let cores = available_cores();
        Ok(Settings {
            host,
            port,
            durability_dir: text_from_env("NARSIL_DURABILITY_DIR").map(PathBuf::from),
            max_body_bytes: count_from_env("NARSIL_MAX_BODY_BYTES")?
                .unwrap_or(DEFAULT_MAX_BODY_BYTES),
            max_import_bytes: count_from_env("NARSIL_MAX_IMPORT_BYTES")?
                .unwrap_or(DEFAULT_MAX_IMPORT_BYTES),
            http_threads: thread_count_from_env("NARSIL_HTTP_THREADS", cores)?,
            search_threads: thread_count_from_env("NARSIL_SEARCH_THREADS", cores)?,
            build: BuildInfo {
                version: text_from_env("NARSIL_BUILD_VERSION"),
                git_sha: text_from_env("NARSIL_BUILD_GIT_SHA"),
                dirty: text_from_env("NARSIL_BUILD_DIRTY").as_deref() == Some("true"),
            },
        })
    }
}
