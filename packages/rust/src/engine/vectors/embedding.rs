use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use crate::adapters::{AdapterError, EmbeddingAdapter};
use crate::config::{AdapterSetting, EmbeddingConfig};
use crate::engine::adapter_registry::{AdapterRegistry, EmbeddingAdapters};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::schema::{BaseType, CompiledSchema, flatten_schema};
use crate::util::unwind::panic_text;
use crate::value::{Map, Value};

/// Where an index finds the adapter that fills its embedded vector fields.
#[derive(Clone)]
enum AdapterSource {
    Instance(Arc<dyn EmbeddingAdapter>),
    Named(String),
    Unbound,
}

/// The embedded vector fields of an index and the adapter that fills them.
#[derive(Clone)]
pub(crate) struct EmbeddingBinding {
    pub(crate) fields: Vec<(String, Vec<String>)>,
    source: AdapterSource,
}

impl EmbeddingBinding {
    /// Returns the adapter as it stands now, which a later registration under the same name replaces.
    pub(crate) fn adapter(&self, registry: &AdapterRegistry) -> Option<Arc<dyn EmbeddingAdapter>> {
        match &self.source {
            AdapterSource::Instance(adapter) => Some(Arc::clone(adapter)),
            AdapterSource::Named(name) => registry.embedding_adapter(name),
            AdapterSource::Unbound => None,
        }
    }

    /// Returns the registered name that the index's configuration gives, or `None` for an instance.
    pub(crate) fn adapter_name(&self) -> Option<&str> {
        match &self.source {
            AdapterSource::Named(name) => Some(name),
            _ => None,
        }
    }
}

fn config_invalid(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::EMBEDDING_CONFIG_INVALID, message)
}

fn mapped_fields(config: &EmbeddingConfig) -> Vec<(String, Vec<String>)> {
    let mut fields: Vec<(String, Vec<String>)> = Vec::with_capacity(config.fields.len());
    for (target, sources) in &config.fields {
        match fields.iter_mut().find(|(held, _)| held == target) {
            Some(entry) => entry.1 = sources.clone(),
            None => fields.push((target.clone(), sources.clone())),
        }
    }
    fields
}

fn type_name_of(flat: &Map, path: &str) -> String {
    flat.get(path)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Checks each mapping of an embedding configuration against the schema and against an adapter's dimensions.
pub(crate) fn validate_embedding_fields(
    fields: &[(String, Vec<String>)],
    schema: &CompiledSchema,
    dimensions: usize,
) -> Result<()> {
    if fields.is_empty() {
        return Err(config_invalid(
            "Embedding config must define at least one field mapping".into(),
        ));
    }
    if dimensions == 0 {
        return Err(config_invalid(format!(
            "Adapter dimensions must be a positive integer, got {dimensions}"
        )));
    }
    let flat = flatten_schema(&schema.definition);
    for (target, sources) in fields {
        let Some(target_type) = schema.field_type(target) else {
            return Err(config_invalid(format!(
                "Embedding target field \"{target}\" does not exist in the schema"
            )));
        };
        if target_type.base != BaseType::Vector {
            return Err(config_invalid(format!(
                "Embedding target field \"{target}\" must be a vector type, got \"{}\"",
                type_name_of(&flat, target)
            )));
        }
        if target_type.dimension as usize != dimensions {
            return Err(NarsilError::new(
                ErrorCode::EMBEDDING_DIMENSION_MISMATCH,
                format!(
                    "Embedding target field \"{target}\" has dimension {} but the adapter produces {dimensions}-dimensional vectors",
                    target_type.dimension
                ),
            ));
        }
        if sources.is_empty() {
            return Err(config_invalid(format!(
                "Embedding target field \"{target}\" must have at least one source field"
            )));
        }
        for source in sources {
            let Some(source_type) = schema.field_type(source) else {
                return Err(config_invalid(format!(
                    "Embedding source field \"{source}\" does not exist in the schema"
                )));
            };
            if source_type.base != BaseType::String {
                return Err(config_invalid(format!(
                    "Embedding source field \"{source}\" must be a string type, got \"{}\"",
                    type_name_of(&flat, source)
                )));
            }
        }
    }
    Ok(())
}

/// Binds an index's embedding configuration to its adapter, checking every mapping as the index is created.
///
/// A `deferred` binding accepts a registered name that the engine does not hold yet, as recovery does before the
/// caller registers the adapter, and leaves the mappings unchecked until then.
pub(crate) fn bind_embedding(
    config: Option<&EmbeddingConfig>,
    schema: &CompiledSchema,
    registered: &EmbeddingAdapters,
    deferred: bool,
) -> Result<Option<EmbeddingBinding>> {
    let Some(config) = config else {
        return Ok(None);
    };
    let fields = mapped_fields(config);
    let source = match &config.adapter {
        Some(AdapterSetting::Named(name)) => match registered.get(name) {
            Some(adapter) => {
                validate_embedding_fields(&fields, schema, adapter.dimensions())?;
                AdapterSource::Named(name.clone())
            }
            None if deferred => AdapterSource::Named(name.clone()),
            None => {
                return Err(config_invalid(format!(
                    "Embedding adapter \"{name}\" is not registered on this engine"
                )));
            }
        },
        Some(AdapterSetting::Instance(adapter)) => {
            validate_embedding_fields(&fields, schema, adapter.dimensions())?;
            AdapterSource::Instance(Arc::clone(adapter))
        }
        None if deferred => AdapterSource::Unbound,
        None => {
            if fields.is_empty() {
                return Err(config_invalid(
                    "Embedding config must define at least one field mapping".into(),
                ));
            }
            return Err(config_invalid(
                "Embedding config requires an adapter (set on the index or the instance)".into(),
            ));
        }
    };
    Ok(Some(EmbeddingBinding { fields, source }))
}

/// What an adapter call returned, with a panic turned into the text that it carried.
pub(crate) enum AdapterFailure {
    Raised(NarsilError),
    Failed(String),
}

impl AdapterFailure {
    fn of(error: AdapterError) -> AdapterFailure {
        match error.downcast::<NarsilError>() {
            Ok(raised) => AdapterFailure::Raised(*raised),
            Err(other) => AdapterFailure::Failed(other.to_string()),
        }
    }

    /// Returns the error to report, keeping an engine error that the adapter raised and wrapping anything else.
    pub(crate) fn into_error(self, wrap: impl FnOnce(String) -> String) -> NarsilError {
        match self {
            AdapterFailure::Raised(raised) => raised,
            AdapterFailure::Failed(message) => {
                NarsilError::new(ErrorCode::EMBEDDING_FAILED, wrap(message))
            }
        }
    }
}

/// Calls an adapter, turning its error and any panic into an [`AdapterFailure`], so that a broken adapter leaves the
/// engine as it was.
pub(crate) fn call_adapter<T>(
    call: impl FnOnce() -> std::result::Result<T, AdapterError>,
) -> std::result::Result<T, AdapterFailure> {
    match catch_unwind(AssertUnwindSafe(call)) {
        Ok(Ok(found)) => Ok(found),
        Ok(Err(error)) => Err(AdapterFailure::of(error)),
        Err(payload) => Err(AdapterFailure::Failed(
            panic_text(payload.as_ref()).unwrap_or_else(|| "the adapter panicked".to_string()),
        )),
    }
}

/// Checks a vector that an adapter returned, which must hold `dimensions` finite elements.
pub(crate) fn require_usable_embedding(
    vector: &[f32],
    dimensions: usize,
    subject: &str,
) -> Result<()> {
    if vector.len() != dimensions {
        return Err(NarsilError::new(
            ErrorCode::EMBEDDING_DIMENSION_MISMATCH,
            format!(
                "Adapter returned {}-dimensional vector for {subject}, expected {dimensions}",
                vector.len()
            ),
        ));
    }
    if let Some(at) = vector.iter().position(|element| element.is_nan()) {
        return Err(NarsilError::new(
            ErrorCode::EMBEDDING_FAILED,
            format!("Adapter returned vector with NaN at index {at} for {subject}"),
        ));
    }
    if let Some(at) = vector.iter().position(|element| element.is_infinite()) {
        return Err(NarsilError::new(
            ErrorCode::EMBEDDING_FAILED,
            format!("Adapter returned vector with an infinite element at index {at} for {subject}"),
        ));
    }
    Ok(())
}
