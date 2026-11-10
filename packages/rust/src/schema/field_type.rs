use crate::error::{ErrorCode, NarsilError, Result};

pub(crate) const MAX_STORED_VECTOR_DIMENSION: u32 = 65_535;
pub(crate) const MAX_VECTOR_DIMENSION: u32 = 4_096;
const TYPE_SEPARATOR: char = ':';
const TEXT_OPTIONS: [&str; 3] = ["sortable", "pattern", "partial"];
const VERBATIM_OPTIONS: [&str; 1] = ["sortable"];

/// The base type of a schema field, which is the part of its type name before the first option.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BaseType {
    /// Text that the engine analyses into words.
    String,
    /// A list of texts that the engine analyses into words.
    StringList,
    /// Text that the engine stores and compares exactly as written.
    Verbatim,
    /// A list of texts that the engine stores and compares exactly as written.
    VerbatimList,
    /// A float64.
    Number,
    /// A list of float64 values.
    NumberList,
    /// A boolean.
    Boolean,
    /// A list of booleans.
    BooleanList,
    /// One string from an open set of values, which the engine indexes whole.
    Enum,
    /// A list of enum values.
    EnumList,
    /// A latitude and a longitude.
    Geopoint,
    /// A vector of a fixed dimension.
    Vector,
}

impl BaseType {
    fn from_name(name: &str) -> Option<BaseType> {
        Some(match name {
            "string" => BaseType::String,
            "string[]" => BaseType::StringList,
            "verbatim" => BaseType::Verbatim,
            "verbatim[]" => BaseType::VerbatimList,
            "number" => BaseType::Number,
            "number[]" => BaseType::NumberList,
            "boolean" => BaseType::Boolean,
            "boolean[]" => BaseType::BooleanList,
            "enum" => BaseType::Enum,
            "enum[]" => BaseType::EnumList,
            "geopoint" => BaseType::Geopoint,
            _ => return None,
        })
    }

    fn options(self) -> &'static [&'static str] {
        match self {
            BaseType::String | BaseType::StringList => &TEXT_OPTIONS,
            BaseType::Verbatim | BaseType::VerbatimList => &VERBATIM_OPTIONS,
            _ => &[],
        }
    }

    /// Returns true for a list type, such as `string[]`.
    pub fn is_list(self) -> bool {
        matches!(
            self,
            BaseType::StringList
                | BaseType::VerbatimList
                | BaseType::NumberList
                | BaseType::BooleanList
                | BaseType::EnumList
        )
    }

    /// Returns true for `string` and `string[]`, the types whose text the engine analyses into words.
    pub fn is_word_indexed(self) -> bool {
        matches!(self, BaseType::String | BaseType::StringList)
    }

    /// Returns true for the types whose values are text.
    pub fn is_string_valued(self) -> bool {
        matches!(
            self,
            BaseType::String | BaseType::StringList | BaseType::Verbatim | BaseType::VerbatimList
        )
    }
}

/// A parsed field type, with its options read out of the type name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldType {
    /// The canonical type name, with the options in the order of the specification.
    pub name: String,
    /// The base type.
    pub base: BaseType,
    /// Whether the field takes the `sortable` option.
    pub sortable: bool,
    /// Whether the field holds a pattern index, which every `verbatim` field does.
    pub pattern: bool,
    /// Whether the field takes the `partial` option.
    pub partial: bool,
    /// The dimension of a vector field, and 0 for every other field.
    pub dimension: u32,
}

fn invalid_type(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::SCHEMA_INVALID_TYPE, message)
}

fn vector_dimension_text(name: &str) -> Option<&str> {
    name.strip_prefix("vector[")?.strip_suffix(']')
}

fn vector_dimension(name: &str) -> Option<&str> {
    let digits = vector_dimension_text(name)?;
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).then_some(digits)
}

fn invalid_dimension(path: &str, shown: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::SCHEMA_INVALID_VECTOR_DIMENSION,
        format!(
            "Vector field \"{path}\" has {shown} dimensions, but a vector field holds a whole number from 1 to {MAX_STORED_VECTOR_DIMENSION}"
        ),
    )
}

fn describe_allowed(base_name: &str, allowed: &[&str]) -> String {
    match allowed {
        [] => format!("the \"{base_name}\" type has no options"),
        [only] => format!("the only option of the \"{base_name}\" type is \"{only}\""),
        _ => {
            let quoted: Vec<String> = allowed
                .iter()
                .map(|option| format!("\"{option}\""))
                .collect();
            format!(
                "the options of the \"{base_name}\" type are {}, and {}",
                quoted[..quoted.len() - 1].join(", "),
                quoted[quoted.len() - 1]
            )
        }
    }
}

/// Parses a type name such as `string:sortable:pattern` and checks its base type and options.
pub fn parse_field_type(type_name: &str, path: &str) -> Result<FieldType> {
    let (base_name, options_text) = match type_name.find(TYPE_SEPARATOR) {
        Some(at) => (&type_name[..at], Some(&type_name[at + 1..])),
        None => (type_name, None),
    };
    let (base, dimension) = match BaseType::from_name(base_name) {
        Some(base) => (base, 0),
        None => {
            let Some(inner) = vector_dimension_text(base_name) else {
                return Err(invalid_type(format!(
                    "Field \"{path}\" has an unsupported type: \"{type_name}\""
                )));
            };
            let Some(digits) = vector_dimension(base_name) else {
                return Err(invalid_dimension(path, &format!("\"{inner}\"")));
            };
            let significant = digits.trim_start_matches('0');
            let too_long = significant.len() > 19;
            let dimension = significant.parse::<u64>().unwrap_or(0);
            if too_long || dimension == 0 || dimension > MAX_STORED_VECTOR_DIMENSION as u64 {
                let shown = if too_long {
                    significant.to_string()
                } else {
                    dimension.to_string()
                };
                return Err(invalid_dimension(path, &shown));
            }
            (BaseType::Vector, dimension as u32)
        }
    };
    let allowed = base.options();
    let mut chosen: Vec<&str> = Vec::new();
    if let Some(options_text) = options_text {
        for option in options_text.split(TYPE_SEPARATOR) {
            if !allowed.contains(&option) {
                return Err(invalid_type(format!(
                    "Field \"{path}\" has type \"{type_name}\" with the option \"{option}\", but {}",
                    describe_allowed(base_name, allowed)
                )));
            }
            if chosen.contains(&option) {
                return Err(invalid_type(format!(
                    "Field \"{path}\" has the \"{option}\" option twice in type \"{type_name}\""
                )));
            }
            chosen.push(option);
        }
    }
    let mut name = base_name.to_string();
    for option in TEXT_OPTIONS {
        if chosen.contains(&option) {
            name.push(TYPE_SEPARATOR);
            name.push_str(option);
        }
    }
    let verbatim = matches!(base, BaseType::Verbatim | BaseType::VerbatimList);
    Ok(FieldType {
        name,
        base,
        sortable: chosen.contains(&"sortable"),
        pattern: verbatim || chosen.contains(&"pattern"),
        partial: chosen.contains(&"partial"),
        dimension,
    })
}
