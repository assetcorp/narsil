use std::sync::Arc;

use narsil::{ErrorCode, IndexConfig, Map, NarsilError, Plugin, QueryParams, QueryResult};
use pyo3::prelude::*;
use pyo3::types::PyDict;

use super::reentry::Reentry;
use super::retained::Retained;
use super::{CallbackFailure, call_python, report_unraisable};
use crate::convert::encode::{index_config_dict, query_dict};
use crate::convert::fields::string_of;
use crate::convert::query::query_params;
use crate::convert::results::query_result;
use crate::convert::value::{ValueSource, map_to_py, to_map};
use crate::errors::config_invalid;

const HOOKS: [&str; 11] = [
    "before_insert",
    "after_insert",
    "before_update",
    "after_update",
    "before_remove",
    "after_remove",
    "before_search",
    "after_search",
    "on_index_create",
    "on_index_drop",
    "on_partition_split",
];

pub(crate) struct PythonPlugin {
    object: Retained,
    name: String,
    hooks: [bool; HOOKS.len()],
}

fn hook_index(hook: &str) -> usize {
    HOOKS
        .iter()
        .position(|known| *known == hook)
        .unwrap_or_default()
}

impl PythonPlugin {
    pub(crate) fn wrap(
        object: &Bound<'_, PyAny>,
        label: &str,
    ) -> Result<Arc<dyn Plugin>, NarsilError> {
        let name = object
            .getattr("name")
            .map_err(|_| config_invalid(format!("{label}.name is required")))?;
        let name = string_of(&name, &format!("{label}.name"))?;
        let mut hooks = [false; HOOKS.len()];
        for (at, hook) in HOOKS.iter().enumerate() {
            hooks[at] = object
                .getattr(*hook)
                .map(|method| method.is_callable())
                .unwrap_or(false);
        }
        Ok(Arc::new(PythonPlugin {
            object: Retained::new(object),
            name,
            hooks,
        }))
    }

    fn has(&self, hook: &str) -> bool {
        self.hooks[hook_index(hook)]
    }

    fn subject(&self, hook: &str) -> String {
        format!("The {hook} hook of plugin \"{}\"", self.name)
    }

    fn refusing<T>(
        &self,
        hook: &'static str,
        code: ErrorCode,
        context: impl for<'py> FnOnce(Python<'py>) -> PyResult<Bound<'py, PyDict>>,
        read: impl for<'py> FnOnce(&Bound<'py, PyDict>) -> Result<T, CallbackFailure>,
    ) -> Result<T, NarsilError> {
        call_python(code, &self.subject(hook), Reentry::Allowed, |py| {
            let context = context(py)?;
            self.object
                .bind(py)?
                .call_method1(hook, (context.clone(),))?;
            read(&context)
        })
    }

    fn reporting(
        &self,
        hook: &'static str,
        context: impl for<'py> FnOnce(Python<'py>) -> PyResult<Bound<'py, PyDict>>,
    ) {
        if !self.has(hook) {
            return;
        }
        let _ = Python::try_attach(|py| {
            let Ok(plugin) = self.object.bind(py) else {
                return;
            };
            let outcome = context(py).and_then(|context| plugin.call_method1(hook, (context,)));
            if let Err(error) = outcome {
                report_unraisable(py, error, &plugin);
            }
        });
    }
}

fn document_under(context: &Bound<'_, PyDict>, key: &str) -> Result<Map, CallbackFailure> {
    let Some(document) = context.get_item(key)? else {
        return Err(CallbackFailure::Refused(config_invalid(format!(
            "the hook removed \"{key}\" from the context"
        ))));
    };
    let subject = format!("context[\"{key}\"]");
    Ok(to_map(
        &document,
        ValueSource {
            code: ErrorCode::DOC_VALIDATION_FAILED,
            subject: &subject,
        },
    )?)
}

fn write_context<'py>(
    py: Python<'py>,
    index_name: &str,
    doc_id: &str,
) -> PyResult<Bound<'py, PyDict>> {
    let context = PyDict::new(py);
    context.set_item("indexName", index_name)?;
    context.set_item("docId", doc_id)?;
    Ok(context)
}

impl Plugin for PythonPlugin {
    fn name(&self) -> &str {
        &self.name
    }

    fn before_insert(
        &self,
        index_name: &str,
        doc_id: &str,
        document: &mut Map,
    ) -> narsil::Result<()> {
        if !self.has("before_insert") {
            return Ok(());
        }
        let current = &*document;
        let changed = self.refusing(
            "before_insert",
            ErrorCode::DOC_VALIDATION_FAILED,
            |py| {
                let context = write_context(py, index_name, doc_id)?;
                context.set_item("document", map_to_py(py, current)?)?;
                Ok(context)
            },
            |context| document_under(context, "document"),
        )?;
        *document = changed;
        Ok(())
    }

    fn after_insert(&self, index_name: &str, doc_id: &str, document: &Map) {
        self.reporting("after_insert", |py| {
            let context = write_context(py, index_name, doc_id)?;
            context.set_item("document", map_to_py(py, document)?)?;
            Ok(context)
        });
    }

    fn before_update(
        &self,
        index_name: &str,
        doc_id: &str,
        old_document: &Map,
        new_document: &mut Map,
    ) -> narsil::Result<()> {
        if !self.has("before_update") {
            return Ok(());
        }
        let current = &*new_document;
        let changed = self.refusing(
            "before_update",
            ErrorCode::DOC_VALIDATION_FAILED,
            |py| {
                let context = write_context(py, index_name, doc_id)?;
                context.set_item("oldDocument", map_to_py(py, old_document)?)?;
                context.set_item("newDocument", map_to_py(py, current)?)?;
                Ok(context)
            },
            |context| document_under(context, "newDocument"),
        )?;
        *new_document = changed;
        Ok(())
    }

    fn after_update(&self, index_name: &str, doc_id: &str, old_document: &Map, new_document: &Map) {
        self.reporting("after_update", |py| {
            let context = write_context(py, index_name, doc_id)?;
            context.set_item("oldDocument", map_to_py(py, old_document)?)?;
            context.set_item("newDocument", map_to_py(py, new_document)?)?;
            Ok(context)
        });
    }

    fn before_remove(&self, index_name: &str, doc_id: &str) -> narsil::Result<()> {
        if !self.has("before_remove") {
            return Ok(());
        }
        self.refusing(
            "before_remove",
            ErrorCode::DOC_VALIDATION_FAILED,
            |py| write_context(py, index_name, doc_id),
            |_| Ok(()),
        )
    }

    fn after_remove(&self, index_name: &str, doc_id: &str) {
        self.reporting("after_remove", |py| write_context(py, index_name, doc_id));
    }

    fn before_search(&self, index_name: &str, params: &mut QueryParams) -> narsil::Result<()> {
        if !self.has("before_search") {
            return Ok(());
        }
        let current = &*params;
        let changed = self.refusing(
            "before_search",
            ErrorCode::HOOK_ERROR,
            |py| {
                let context = PyDict::new(py);
                context.set_item("indexName", index_name)?;
                context.set_item("params", query_dict(py, current)?)?;
                Ok(context)
            },
            |context| {
                let Some(params) = context.get_item("params")? else {
                    return Err(CallbackFailure::Refused(config_invalid(
                        "the hook removed \"params\" from the context",
                    )));
                };
                Ok(query_params(&params, "context[\"params\"]")?)
            },
        )?;
        *params = changed;
        Ok(())
    }

    fn after_search(&self, index_name: &str, params: &QueryParams, result: &QueryResult) {
        self.reporting("after_search", |py| {
            let context = PyDict::new(py);
            context.set_item("indexName", index_name)?;
            context.set_item("params", query_dict(py, params)?)?;
            context.set_item("results", query_result(py, result)?)?;
            Ok(context)
        });
    }

    fn on_index_create(&self, index_name: &str, config: &IndexConfig) {
        self.reporting("on_index_create", |py| {
            let context = PyDict::new(py);
            context.set_item("indexName", index_name)?;
            context.set_item("config", index_config_dict(py, config)?)?;
            Ok(context)
        });
    }

    fn on_index_drop(&self, index_name: &str, config: &IndexConfig) {
        self.reporting("on_index_drop", |py| {
            let context = PyDict::new(py);
            context.set_item("indexName", index_name)?;
            context.set_item("config", index_config_dict(py, config)?)?;
            Ok(context)
        });
    }

    fn on_partition_split(&self, index_name: &str, old_count: usize, new_count: usize) {
        self.reporting("on_partition_split", |py| {
            let context = PyDict::new(py);
            context.set_item("indexName", index_name)?;
            context.set_item("oldCount", old_count)?;
            context.set_item("newCount", new_count)?;
            Ok(context)
        });
    }
}
