use super::operands::{GeoPolygon, GeoRadius, Scalar, Tolerance};
use crate::value::{Map, Value};

/// A filter expression: tests on fields, combined with `and`, `or`, and `not`.
///
/// The engine checks a filter against the index schema when a search runs, so a filter
/// built here or read from JSON fails with the same error codes and messages either way.
#[derive(Debug, Clone, PartialEq)]
pub struct Filter {
    value: Value,
}

impl Default for Filter {
    fn default() -> Filter {
        Filter {
            value: Value::Object(Map::new()),
        }
    }
}

impl Filter {
    /// Returns an empty filter, which every live document passes.
    pub fn new() -> Filter {
        Filter::default()
    }

    /// Returns a filter that tests one field, named by its dotted path.
    pub fn field(path: impl Into<String>, tests: FieldTests) -> Filter {
        Filter::new().with_field(path, tests)
    }

    /// Returns this filter with the tests on one more field added, replacing any earlier tests on that field.
    pub fn with_field(self, path: impl Into<String>, tests: FieldTests) -> Filter {
        let mut fields = match &self.value {
            Value::Object(expression) => match expression.get("fields") {
                Some(Value::Object(fields)) => fields.clone(),
                _ => Map::new(),
            },
            _ => Map::new(),
        };
        fields.insert(path, Value::Object(tests.into_map()));
        self.with_key("fields", Value::Object(fields))
    }

    /// Returns a filter that a document passes only when it passes every filter in `filters`.
    pub fn all(filters: impl IntoIterator<Item = Filter>) -> Filter {
        Filter::new().with_clause("and", filters)
    }

    /// Returns a filter that a document passes when it passes at least one filter in `filters`.
    pub fn any(filters: impl IntoIterator<Item = Filter>) -> Filter {
        Filter::new().with_clause("or", filters)
    }

    /// Returns a filter that a document passes only when it fails `filter`.
    pub fn negate(filter: Filter) -> Filter {
        Filter::new().with_key("not", filter.into_value())
    }

    /// Wraps a filter expression read from JSON or MessagePack, which the engine checks when a search runs.
    pub fn from_value(value: Value) -> Filter {
        Filter { value }
    }

    /// Returns the filter as the expression object that the HTTP server and the JSON form take.
    pub fn to_value(&self) -> Value {
        self.value.clone()
    }

    /// Returns the filter as an expression object, consuming the filter.
    pub fn into_value(self) -> Value {
        self.value
    }

    fn with_key(self, key: &str, value: Value) -> Filter {
        let mut expression = match self.value {
            Value::Object(expression) => expression,
            _ => Map::new(),
        };
        expression.insert(key, value);
        Filter {
            value: Value::Object(expression),
        }
    }

    fn with_clause(self, clause: &str, filters: impl IntoIterator<Item = Filter>) -> Filter {
        let listed: Vec<Value> = filters.into_iter().map(Filter::into_value).collect();
        self.with_key(clause, Value::Array(listed))
    }
}

impl From<Filter> for Value {
    fn from(filter: Filter) -> Value {
        filter.into_value()
    }
}

impl From<Value> for Filter {
    fn from(value: Value) -> Filter {
        Filter::from_value(value)
    }
}

/// The tests that a filter applies to one field, which a document must pass together.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FieldTests {
    map: Map,
}

fn texts_value<T: Into<String>>(texts: impl IntoIterator<Item = T>) -> Value {
    Value::Array(
        texts
            .into_iter()
            .map(|text| Value::String(text.into()))
            .collect(),
    )
}

fn scalars_value<T: Into<Scalar>>(values: impl IntoIterator<Item = T>) -> Value {
    Value::Array(
        values
            .into_iter()
            .map(|value| Value::from(value.into()))
            .collect(),
    )
}

impl FieldTests {
    /// Returns an empty set of tests.
    pub fn new() -> FieldTests {
        FieldTests::default()
    }

    fn with(mut self, operator: &str, operand: Value) -> FieldTests {
        self.map.insert(operator, operand);
        self
    }

    fn into_map(self) -> Map {
        self.map
    }

    /// Passes a document whose value equals `value`.
    pub fn eq(self, value: impl Into<Scalar>) -> FieldTests {
        self.with("eq", value.into().into())
    }

    /// Passes a document that holds a value in the field, other than `value`.
    pub fn ne(self, value: impl Into<Scalar>) -> FieldTests {
        self.with("ne", value.into().into())
    }

    /// Passes a document whose value is above `bound`, a number or, on a sortable text field, a text.
    pub fn gt(self, bound: impl Into<Scalar>) -> FieldTests {
        self.with("gt", bound.into().into())
    }

    /// Passes a document whose value is at or above `bound`.
    pub fn gte(self, bound: impl Into<Scalar>) -> FieldTests {
        self.with("gte", bound.into().into())
    }

    /// Passes a document whose value is below `bound`.
    pub fn lt(self, bound: impl Into<Scalar>) -> FieldTests {
        self.with("lt", bound.into().into())
    }

    /// Passes a document whose value is at or below `bound`.
    pub fn lte(self, bound: impl Into<Scalar>) -> FieldTests {
        self.with("lte", bound.into().into())
    }

    /// Passes a document whose value lies from `low` to `high`, both included.
    pub fn between(self, low: impl Into<Scalar>, high: impl Into<Scalar>) -> FieldTests {
        let bounds = Value::Array(vec![low.into().into(), high.into().into()]);
        self.with("between", bounds)
    }

    /// Passes a document whose value equals one of `texts`.
    pub fn is_in<T: Into<String>>(self, texts: impl IntoIterator<Item = T>) -> FieldTests {
        self.with("in", texts_value(texts))
    }

    /// Passes a document that holds a value in the field, other than every one of `texts`.
    pub fn not_in<T: Into<String>>(self, texts: impl IntoIterator<Item = T>) -> FieldTests {
        self.with("nin", texts_value(texts))
    }

    /// Passes a document whose value starts with `text`.
    pub fn starts_with(self, text: impl Into<String>) -> FieldTests {
        self.with("startsWith", Value::String(text.into()))
    }

    /// Passes a document whose value ends with `text`.
    pub fn ends_with(self, text: impl Into<String>) -> FieldTests {
        self.with("endsWith", Value::String(text.into()))
    }

    /// Passes a document whose value holds `text` anywhere, on a pattern field.
    pub fn contains(self, text: impl Into<String>) -> FieldTests {
        self.with("contains", Value::String(text.into()))
    }

    /// Passes a document whose whole value matches `pattern`, where `*` stands for any run of code points and `?` for one.
    pub fn wildcard(self, pattern: impl Into<String>) -> FieldTests {
        self.with("wildcard", Value::String(pattern.into()))
    }

    /// Passes a document whose value holds a match of `pattern`, in the engine's regular expression grammar.
    pub fn regex(self, pattern: impl Into<String>) -> FieldTests {
        self.with("regex", Value::String(pattern.into()))
    }

    /// Sets whether the pattern tests on this field compare case folds in place of exact code points.
    pub fn case_fold(self, case_fold: bool) -> FieldTests {
        self.with("caseFold", Value::Bool(case_fold))
    }

    /// Sets how many edits the `eq` test on this pattern field forgives.
    pub fn tolerance(self, tolerance: Tolerance) -> FieldTests {
        self.with("tolerance", tolerance.into())
    }

    /// Passes a document whose list holds every one of `values`.
    pub fn contains_all<T: Into<Scalar>>(self, values: impl IntoIterator<Item = T>) -> FieldTests {
        self.with("containsAll", scalars_value(values))
    }

    /// Passes a document whose list holds at least one of `values`.
    pub fn matches_any<T: Into<Scalar>>(self, values: impl IntoIterator<Item = T>) -> FieldTests {
        self.with("matchesAny", scalars_value(values))
    }

    /// Passes a document whose list length passes `comparison`, which takes the number tests alone.
    pub fn size(self, comparison: FieldTests) -> FieldTests {
        self.with("size", Value::Object(comparison.into_map()))
    }

    /// Passes a document that holds a value in the field.
    pub fn exists(self) -> FieldTests {
        self.with("exists", Value::Bool(true))
    }

    /// Passes a document that holds no value in the field.
    pub fn not_exists(self) -> FieldTests {
        self.with("notExists", Value::Bool(true))
    }

    /// Passes a document that holds no value in the field, an empty text, or an empty list.
    pub fn is_empty(self) -> FieldTests {
        self.with("isEmpty", Value::Bool(true))
    }

    /// Passes a document that holds a value in the field other than an empty text or an empty list.
    pub fn is_not_empty(self) -> FieldTests {
        self.with("isNotEmpty", Value::Bool(true))
    }

    /// Passes a document whose point lies within `circle`, or outside it where the circle says so.
    pub fn radius(self, circle: GeoRadius) -> FieldTests {
        self.with("radius", Value::Object(circle.into_map()))
    }

    /// Passes a document whose point lies inside `polygon`, or outside it where the polygon says so.
    pub fn polygon(self, polygon: GeoPolygon) -> FieldTests {
        self.with("polygon", Value::Object(polygon.into_map()))
    }
}
