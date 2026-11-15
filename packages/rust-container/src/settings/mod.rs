mod adapters;
pub mod constants;
mod limits;
pub mod types;
mod urls;
mod variables;
mod webhooks;

use std::path::PathBuf;

pub use types::ContainerSettings;
use types::{
    AccessKeys, BuildSettings, CorsOrigins, DurabilityChoice, EngineSettings, NetworkSettings,
    StorageKind, StorageSettings,
};
pub use urls::parse_http_url;
pub use variables::Environment;
use variables::{Setting, SettingError, VariableReader, WholeNumberRange};

use constants::{
    DEFAULT_DATA_DIR, DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, DEFAULT_LANGUAGE, MAX_HTTP_PORT,
    MIN_KEY_CHARACTERS, MIN_QUERY_SUGGESTIONS_KEY_BYTES,
};

const ANY_ORIGIN: &str = "*";
const HOST_NAME_FILES: [&str; 2] = ["/proc/sys/kernel/hostname", "/etc/hostname"];

fn read_cors(reader: &VariableReader<'_>) -> Setting<Option<CorsOrigins>> {
    let Some(origins) = reader.list("NARSIL_CORS_ORIGINS")? else {
        return Ok(None);
    };
    if origins.len() == 1 && origins[0] == ANY_ORIGIN {
        return Ok(Some(CorsOrigins::Any));
    }
    for origin in &origins {
        let is_origin = parse_http_url(origin).is_some_and(|url| {
            !url.has_user_info
                && !url.default_port
                && url.authority == url.authority.to_ascii_lowercase()
                && *origin == format!("{}://{}", url.scheme, url.authority)
        });
        if !is_origin {
            return Err(SettingError::new(
                "NARSIL_CORS_ORIGINS",
                "must be * or a list of origins such as https://app.example.com",
            ));
        }
    }
    Ok(Some(CorsOrigins::List(origins)))
}

fn read_key(reader: &VariableReader<'_>, variable: &str) -> Setting<Option<String>> {
    let Some(key) = reader.text(variable)? else {
        return Ok(None);
    };
    if key.chars().count() < MIN_KEY_CHARACTERS {
        return Err(SettingError::new(
            variable,
            format!("must hold at least {MIN_KEY_CHARACTERS} characters"),
        ));
    }
    Ok(Some(key))
}

fn read_keys(reader: &VariableReader<'_>) -> Setting<AccessKeys> {
    let admin = read_key(reader, "NARSIL_ADMIN_KEY")?;
    let read = read_key(reader, "NARSIL_READ_KEY")?;
    if admin.is_some() && admin == read {
        return Err(SettingError::new(
            "NARSIL_READ_KEY",
            "must differ from NARSIL_ADMIN_KEY",
        ));
    }
    Ok(AccessKeys { admin, read })
}

fn host_name() -> Option<String> {
    HOST_NAME_FILES.iter().find_map(|file| {
        std::fs::read_to_string(file)
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|name| !name.is_empty())
    })
}

fn read_network(reader: &VariableReader<'_>) -> Setting<NetworkSettings> {
    let host = reader
        .text("NARSIL_HTTP_HOST")?
        .unwrap_or_else(|| DEFAULT_HTTP_HOST.to_string());
    let port = reader
        .whole_number(
            "NARSIL_HTTP_PORT",
            WholeNumberRange {
                min: 1,
                max: Some(MAX_HTTP_PORT),
            },
        )?
        .unwrap_or(DEFAULT_HTTP_PORT);
    Ok(NetworkSettings {
        host,
        port: u16::try_from(port).unwrap_or(u16::MAX),
        cors: read_cors(reader)?,
        allow_insecure: reader.boolean("NARSIL_ALLOW_INSECURE")?.unwrap_or(false),
        instance_id: reader.text("NARSIL_INSTANCE_ID")?.or_else(host_name),
    })
}

fn read_storage(
    reader: &VariableReader<'_>,
    warnings: &mut Vec<String>,
) -> Setting<StorageSettings> {
    let kind = match reader.one_of("NARSIL_STORAGE", &["filesystem", "memory"])? {
        Some("memory") => StorageKind::Memory,
        _ => StorageKind::Filesystem,
    };
    let data_dir = PathBuf::from(
        reader
            .text("NARSIL_DATA_DIR")?
            .unwrap_or_else(|| DEFAULT_DATA_DIR.to_string()),
    );
    if !data_dir.is_absolute() {
        return Err(SettingError::new(
            "NARSIL_DATA_DIR",
            "must be an absolute path",
        ));
    }
    let durability_mode = match reader.one_of("NARSIL_DURABILITY_MODE", &["sync", "async"])? {
        Some("async") => DurabilityChoice::Async,
        _ => DurabilityChoice::Sync,
    };
    if kind == StorageKind::Memory {
        warnings.push("NARSIL_STORAGE is memory, so a restart loses every index".to_string());
    }
    Ok(StorageSettings {
        kind,
        data_dir,
        durability_mode,
    })
}

fn is_language_name(name: &str) -> bool {
    name.split('-')
        .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_lowercase()))
}

fn read_engine(reader: &VariableReader<'_>) -> Setting<EngineSettings> {
    let listed = reader
        .list("NARSIL_LANGUAGES")?
        .unwrap_or_else(|| vec![DEFAULT_LANGUAGE.to_string()]);
    if !listed.iter().all(|language| is_language_name(language)) {
        return Err(SettingError::new(
            "NARSIL_LANGUAGES",
            "must hold language module names such as english or haitian-creole",
        ));
    }
    let mut languages: Vec<String> = Vec::with_capacity(listed.len());
    for language in listed {
        if !languages.contains(&language) {
            languages.push(language);
        }
    }
    Ok(EngineSettings {
        languages,
        workers: reader.whole_number("NARSIL_WORKERS", WholeNumberRange { min: 0, max: None })?,
        promotion_threshold: reader.whole_number(
            "NARSIL_PROMOTION_THRESHOLD",
            WholeNumberRange { min: 1, max: None },
        )?,
        allow_regex: reader.boolean("NARSIL_ALLOW_REGEX")?.unwrap_or(true),
    })
}

fn read_query_suggestions(
    reader: &VariableReader<'_>,
    warnings: &mut Vec<String>,
) -> Setting<Option<String>> {
    let enabled = reader.boolean("NARSIL_QUERY_SUGGESTIONS")?.unwrap_or(false);
    let key = reader.text("NARSIL_QUERY_SUGGESTIONS_KEY")?;
    if !enabled {
        if key.is_some() {
            warnings.push(
                "NARSIL_QUERY_SUGGESTIONS_KEY takes effect only while NARSIL_QUERY_SUGGESTIONS is true"
                    .to_string(),
            );
        }
        return Ok(None);
    }
    match key {
        Some(key) if key.len() >= MIN_QUERY_SUGGESTIONS_KEY_BYTES => Ok(Some(key)),
        _ => Err(SettingError::new(
            "NARSIL_QUERY_SUGGESTIONS_KEY",
            format!(
                "must be set to at least {MIN_QUERY_SUGGESTIONS_KEY_BYTES} bytes in UTF-8 while NARSIL_QUERY_SUGGESTIONS is true"
            ),
        )),
    }
}

fn require_credential_rules(settings: &ContainerSettings) -> Setting<()> {
    let has_key = settings.keys.any();
    if !has_key && !settings.network.allow_insecure {
        return Err(SettingError::new(
            "NARSIL_ADMIN_KEY",
            "or NARSIL_READ_KEY must be set, unless NARSIL_ALLOW_INSECURE is true",
        ));
    }
    if !has_key && settings.sync {
        return Err(SettingError::new(
            "NARSIL_SYNC",
            "can be true only with NARSIL_ADMIN_KEY or NARSIL_READ_KEY set",
        ));
    }
    if !has_key && settings.changes {
        return Err(SettingError::new(
            "NARSIL_CHANGES",
            "can be true only with NARSIL_ADMIN_KEY or NARSIL_READ_KEY set",
        ));
    }
    Ok(())
}

pub fn read_settings(environment: &Environment) -> Result<ContainerSettings, String> {
    let reader = VariableReader::new(environment);
    let mut warnings = Vec::new();
    read_all(&reader, &mut warnings).map_err(|failure| failure.line())
}

fn read_all(reader: &VariableReader<'_>, warnings: &mut Vec<String>) -> Setting<ContainerSettings> {
    let network = read_network(reader)?;
    let keys = read_keys(reader)?;
    let storage = read_storage(reader, warnings)?;
    let engine = read_engine(reader)?;
    let limits = limits::read_limits(reader)?;
    let embedders = adapters::read_embedders(reader)?;
    let rerankers = adapters::read_rerankers(reader)?;
    let sync = reader.boolean("NARSIL_SYNC")?.unwrap_or(false);
    let changes = reader.boolean("NARSIL_CHANGES")?.unwrap_or(false);
    let query_suggestions_key = read_query_suggestions(reader, warnings)?;
    let webhook = webhooks::read_webhook(reader, warnings)?;
    let build = BuildSettings {
        version: reader.text("NARSIL_BUILD_VERSION")?,
        git_sha: reader.text("NARSIL_BUILD_GIT_SHA")?,
    };
    let mut settings = ContainerSettings {
        network,
        keys,
        storage,
        engine,
        limits,
        embedders,
        rerankers,
        sync,
        changes,
        query_suggestions_key,
        webhook,
        build,
        warnings: Vec::new(),
    };
    require_credential_rules(&settings)?;
    for name in reader.unconsulted_names() {
        warnings.push(format!(
            "{name} is no variable of the container specification, so the startup program ignores it"
        ));
    }
    settings.warnings = std::mem::take(warnings);
    Ok(settings)
}
