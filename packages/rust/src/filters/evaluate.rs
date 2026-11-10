use std::collections::HashMap;

use super::compile::{
    CompiledExpression, ElementTest, EnumMatch, FieldFilter, FieldTest, NumberTest, TextBound,
};
use super::source::{
    Comparison, FilterSource, NumericView, PatternSource, and_into, and_not_into, bitset_words,
    empty_bits, is_empty_bits, or_into, set_bit,
};
use crate::error::Result;
use crate::pattern::{
    GrowingPatternIndex, PatternIndexRef, PatternScratch, PatternTarget, PreparedPattern,
    TextValues, WorkMeter, match_pattern,
};
use crate::schema::BaseType;

struct SourceTexts<'a, S: FilterSource> {
    source: &'a S,
    field: &'a str,
}

impl<S: FilterSource> TextValues for SourceTexts<'_, S> {
    fn for_each_text(
        &self,
        ordinal: u32,
        visit: &mut dyn FnMut(&str) -> Result<bool>,
    ) -> Result<()> {
        self.source.for_each_text(self.field, ordinal, visit)
    }
}

struct FilterRun<'a, S: FilterSource> {
    source: &'a S,
    live: Vec<u32>,
    holds_removed: bool,
    capacity: u32,
    meter: &'a WorkMeter,
    scratch: &'a mut PatternScratch,
    built_indexes: HashMap<String, GrowingPatternIndex>,
    present: HashMap<String, Vec<u32>>,
}

fn narrow(narrowed: &mut Option<Vec<u32>>, bits: Vec<u32>) {
    match narrowed {
        Some(current) => and_into(current, &bits),
        None => *narrowed = Some(bits),
    }
}

fn bound_of(bound: &Option<TextBound>) -> Option<(&str, bool)> {
    bound
        .as_ref()
        .map(|bound| (bound.text.as_str(), bound.inclusive))
}

fn without(mut from: Vec<u32>, removed: &[u32]) -> Vec<u32> {
    and_not_into(&mut from, removed);
    from
}

pub(crate) fn evaluate_filter<S: FilterSource>(
    filter: &CompiledExpression,
    source: &S,
    live: &[u32],
    meter: &WorkMeter,
    scratch: &mut PatternScratch,
) -> Result<Vec<u32>> {
    let capacity = source.capacity();
    let mut owned_live = empty_bits(capacity);
    for (word, held) in owned_live.iter_mut().zip(live) {
        *word = *held;
    }
    if let Some(last) = owned_live.last_mut() {
        let spare = bitset_words(capacity) as u32 * 32 - capacity;
        if spare > 0 {
            *last &= u32::MAX >> spare;
        }
    }
    let live_count: u32 = owned_live.iter().map(|word| word.count_ones()).sum();
    let mut run = FilterRun {
        source,
        live: owned_live,
        holds_removed: live_count < capacity,
        capacity,
        meter,
        scratch,
        built_indexes: HashMap::new(),
        present: HashMap::new(),
    };
    let mut result = run.expression(filter)?;
    and_into(&mut result, &run.live);
    Ok(result)
}

impl<S: FilterSource> FilterRun<'_, S> {
    fn none(&self) -> Vec<u32> {
        empty_bits(self.capacity)
    }

    fn complement(&self, bits: &[u32]) -> Vec<u32> {
        without(self.live.clone(), bits)
    }

    fn expression(&mut self, expression: &CompiledExpression) -> Result<Vec<u32>> {
        let mut narrowed = None;
        for field in &expression.fields {
            self.field(field, &mut narrowed)?;
        }
        for nested in &expression.and {
            let bits = self.expression(nested)?;
            narrow(&mut narrowed, bits);
        }
        if !expression.or.is_empty() {
            let mut union = self.none();
            for nested in &expression.or {
                or_into(&mut union, &self.expression(nested)?);
            }
            narrow(&mut narrowed, union);
        }
        if let Some(not) = &expression.not {
            let excluded = self.expression(not)?;
            narrow(&mut narrowed, self.complement(&excluded));
        }
        Ok(narrowed.unwrap_or_else(|| self.live.clone()))
    }

    fn present(&mut self, field: &str, base: BaseType) -> Vec<u32> {
        if let Some(bits) = self.present.get(field) {
            return bits.clone();
        }
        let mut bits = self.none();
        let source = self.source;
        match base {
            BaseType::Number => {
                if let Some(view) = source.numeric(field) {
                    view.documents_into(&mut bits);
                }
            }
            BaseType::Boolean => {
                if let Some(view) = source.booleans(field) {
                    for &ordinal in view.true_documents.iter().chain(view.false_documents) {
                        set_bit(&mut bits, ordinal);
                    }
                }
            }
            BaseType::Enum => {
                if let Some(view) = source.enums(field) {
                    view.documents_into(&mut bits);
                }
            }
            BaseType::Geopoint => {
                if let Some(view) = source.geopoints(field) {
                    view.for_each_point(|ordinal, _, _| set_bit(&mut bits, ordinal));
                }
            }
            BaseType::Vector => {}
            _ => {
                if let Some(view) = source.sizes(field) {
                    view.documents_into(&mut bits);
                }
            }
        }
        and_into(&mut bits, &self.live);
        self.present.insert(field.to_string(), bits.clone());
        bits
    }

    fn holding(&mut self, field: &str, base: BaseType) -> Vec<u32> {
        let present = self.present(field, base);
        let Some(sizes) = self.source.sizes(field) else {
            return present;
        };
        let mut empty = self.none();
        sizes.select_into(Comparison::Eq(0.0), &mut empty);
        without(present, &empty)
    }

    fn compared(
        &mut self,
        view: Option<NumericView<'_>>,
        test: &NumberTest,
        field: &str,
        base: BaseType,
    ) -> Vec<u32> {
        match test {
            NumberTest::Is(comparison) => {
                let mut bits = self.none();
                if let Some(view) = view {
                    view.select_into(*comparison, &mut bits);
                }
                bits
            }
            NumberTest::IsNot(value) => {
                let mut equal = self.none();
                if let Some(view) = view {
                    view.select_into(Comparison::Eq(*value), &mut equal);
                }
                without(self.present(field, base), &equal)
            }
        }
    }

    fn field(&mut self, filter: &FieldFilter, narrowed: &mut Option<Vec<u32>>) -> Result<()> {
        let field = filter.path.as_str();
        let base = filter.base;
        for test in &filter.tests {
            let bits = self.field_test(test, field, base)?;
            narrow(narrowed, bits);
        }
        Ok(())
    }

    fn field_test(&mut self, test: &FieldTest, field: &str, base: BaseType) -> Result<Vec<u32>> {
        let source = self.source;
        Ok(match test {
            FieldTest::Presence { keep_present } => {
                let present = self.present(field, base);
                if *keep_present {
                    present
                } else {
                    self.complement(&present)
                }
            }
            FieldTest::Holding { keep_holding } => {
                let holding = self.holding(field, base);
                if *keep_holding {
                    holding
                } else {
                    self.complement(&holding)
                }
            }
            FieldTest::Location(query) => {
                let mut bits = self.none();
                if let Some(view) = source.geopoints(field) {
                    view.for_each_point(|ordinal, lat, lon| {
                        if query.selects(lat, lon) {
                            set_bit(&mut bits, ordinal);
                        }
                    });
                }
                bits
            }
            FieldTest::TextRange { lower, upper } => {
                let mut bits = self.none();
                source.text_range_into(
                    field,
                    bound_of(lower),
                    bound_of(upper),
                    &self.live,
                    &mut bits,
                )?;
                bits
            }
            FieldTest::Pattern { patterns, exclude } => {
                let matched = self.patterns(field, patterns)?;
                if *exclude {
                    without(self.present(field, base), &matched)
                } else {
                    matched
                }
            }
            FieldTest::Number(test) => self.compared(source.numeric(field), test, field, base),
            FieldTest::Size(test) => self.compared(source.sizes(field), test, field, base),
            FieldTest::Boolean { value, exclude } => {
                let equal = self.boolean_bits(field, *value);
                if *exclude {
                    without(self.present(field, base), &equal)
                } else {
                    equal
                }
            }
            FieldTest::Enum { values, exclude } => {
                let mut matched = self.none();
                if let Some(view) = source.enums(field) {
                    match values {
                        EnumMatch::Values(wanted) => {
                            view.select_into(|value| wanted.contains(value), &mut matched)
                        }
                        EnumMatch::Prefix(prefix) => view
                            .select_into(|value| value.starts_with(prefix.as_str()), &mut matched),
                        EnumMatch::Suffix(suffix) => {
                            view.select_into(|value| value.ends_with(suffix.as_str()), &mut matched)
                        }
                    }
                }
                if *exclude {
                    without(self.present(field, base), &matched)
                } else {
                    matched
                }
            }
            FieldTest::AnyPattern(patterns) => self.patterns(field, patterns)?,
            FieldTest::AnyEnum(wanted) => {
                let mut matched = self.none();
                if let Some(view) = source.enums(field) {
                    view.select_into(|value| wanted.contains(value), &mut matched);
                }
                matched
            }
            FieldTest::AnyScalar { numbers, booleans } => {
                let mut union = self.none();
                if let Some(view) = source.numeric(field) {
                    for number in numbers {
                        view.select_into(Comparison::Eq(*number), &mut union);
                    }
                }
                for value in booleans {
                    or_into(&mut union, &self.boolean_bits(field, *value));
                }
                union
            }
            FieldTest::AllElements(elements) => {
                let mut all = self.present(field, base);
                for element in elements {
                    if is_empty_bits(&all) {
                        break;
                    }
                    let bits = self.element_bits(element, field)?;
                    and_into(&mut all, &bits);
                }
                all
            }
        })
    }

    fn boolean_bits(&self, field: &str, value: bool) -> Vec<u32> {
        let mut bits = self.none();
        if let Some(view) = self.source.booleans(field) {
            for &ordinal in view.documents_of(value) {
                set_bit(&mut bits, ordinal);
            }
        }
        bits
    }

    fn element_bits(&mut self, element: &ElementTest, field: &str) -> Result<Vec<u32>> {
        let source = self.source;
        let mut bits = self.none();
        match element {
            ElementTest::Pattern(pattern) => {
                return self.patterns(field, std::slice::from_ref(pattern.as_ref()));
            }
            ElementTest::Number(number) => {
                if let Some(view) = source.numeric(field) {
                    view.select_into(Comparison::Eq(*number), &mut bits);
                }
            }
            ElementTest::Boolean(value) => return Ok(self.boolean_bits(field, *value)),
            ElementTest::Enum(wanted) => {
                if let Some(view) = source.enums(field) {
                    view.select_into(|value| value == wanted, &mut bits);
                }
            }
        }
        Ok(bits)
    }

    fn patterns(&mut self, field: &str, patterns: &[PreparedPattern]) -> Result<Vec<u32>> {
        let mut matched = self.none();
        let source = self.source;
        let index = match source.patterns(field) {
            None => return Ok(matched),
            Some(PatternSource::Index(index)) => index,
            Some(PatternSource::Values(values)) => {
                let built = self
                    .built_indexes
                    .entry(field.to_string())
                    .or_insert_with(|| {
                        GrowingPatternIndex::from_values(
                            values.iter().map(|(ordinal, value)| (*ordinal, value)),
                        )
                    });
                PatternIndexRef::Growing(built)
            }
        };
        let texts = SourceTexts { source, field };
        let target = PatternTarget {
            index,
            live: self.holds_removed.then_some(self.live.as_slice()),
            values: &texts,
        };
        for pattern in patterns {
            match_pattern(pattern, &target, &mut matched, self.meter, self.scratch)?;
        }
        Ok(matched)
    }
}
