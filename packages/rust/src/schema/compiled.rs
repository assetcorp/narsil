use std::collections::HashSet;

use super::{BaseType, FieldType, SchemaField, parse_field_type, schema_fields};
use crate::error::Result;
use crate::value::{Map, Value};

pub(crate) enum LevelEntry {
    Nested {
        field: String,
        path: String,
        children: Vec<LevelEntry>,
    },
    Leaf {
        field: String,
        path: String,
        field_type: FieldType,
    },
}

/// A checked schema, held in the three shapes that the engine reads it in.
pub(crate) struct CompiledSchema {
    pub(crate) definition: Map,
    pub(crate) fields: Vec<SchemaField>,
    pub(crate) levels: Vec<LevelEntry>,
    pub(crate) vector_paths: HashSet<String>,
}

fn compile_level(definition: &Map, prefix: &str) -> Result<Vec<LevelEntry>> {
    let mut entries = Vec::with_capacity(definition.len());
    for (field, type_value) in definition.iter() {
        let path = if prefix.is_empty() {
            field.clone()
        } else {
            format!("{prefix}.{field}")
        };
        match type_value {
            Value::Object(nested) => {
                let children = compile_level(nested, &path)?;
                entries.push(LevelEntry::Nested {
                    field: field.clone(),
                    path,
                    children,
                });
            }
            Value::String(type_name) => {
                let field_type = parse_field_type(type_name, &path)?;
                entries.push(LevelEntry::Leaf {
                    field: field.clone(),
                    path,
                    field_type,
                });
            }
            _ => {}
        }
    }
    Ok(entries)
}

impl CompiledSchema {
    /// Compiles a canonical nested definition that [`super::validate_schema`] has already checked.
    pub(crate) fn of(definition: Map) -> Result<CompiledSchema> {
        let fields = schema_fields(&definition)?;
        let levels = compile_level(&definition, "")?;
        let vector_paths = fields
            .iter()
            .filter(|field| field.field_type.base == BaseType::Vector)
            .map(|field| field.path.clone())
            .collect();
        Ok(CompiledSchema {
            definition,
            fields,
            levels,
            vector_paths,
        })
    }

    pub(crate) fn field(&self, path: &str) -> Option<&SchemaField> {
        self.fields.iter().find(|field| field.path == path)
    }

    pub(crate) fn field_type(&self, path: &str) -> Option<&FieldType> {
        self.field(path).map(|field| &field.field_type)
    }

    pub(crate) fn partial_fields(&self) -> Vec<String> {
        super::partial_field_paths(&self.fields)
    }
}
