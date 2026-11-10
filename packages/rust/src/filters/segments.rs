use std::borrow::Cow;

use super::source::{
    BooleanView, EnumView, FilterSource, GeoView, NumericView, PatternSource, SortValue,
};
use super::stored::{
    stored_field, stored_min_sort_value, value_min_sort_value, visit_stored_texts,
    visit_value_texts,
};
use crate::error::Result;
use crate::index::frozen::FrozenSegment;
use crate::index::indexed::nested_value;
use crate::index::tail::TailSegment;
use crate::pattern::PatternIndexRef;

fn column_of<'a, C>(columns: &'a [C], field: &str, field_of: impl Fn(&C) -> &str) -> Option<&'a C> {
    columns.iter().find(|column| field_of(column) == field)
}

impl FilterSource for FrozenSegment {
    fn capacity(&self) -> u32 {
        FrozenSegment::capacity(self)
    }

    fn numeric(&self, field: &str) -> Option<NumericView<'_>> {
        let column = column_of(&self.payload.numeric, field, |column| &column.field)?;
        Some(NumericView::Sorted {
            documents: &column.documents,
            values: &column.values,
        })
    }

    fn sizes(&self, field: &str) -> Option<NumericView<'_>> {
        let column = column_of(&self.payload.sizes, field, |column| &column.field)?;
        Some(NumericView::Sorted {
            documents: &column.documents,
            values: &column.values,
        })
    }

    fn booleans(&self, field: &str) -> Option<BooleanView<'_>> {
        let column = column_of(&self.payload.boolean, field, |column| &column.field)?;
        Some(BooleanView {
            true_documents: &column.true_documents,
            false_documents: &column.false_documents,
        })
    }

    fn enums(&self, field: &str) -> Option<EnumView<'_>> {
        let column = column_of(&self.payload.enums, field, |column| &column.field)?;
        Some(EnumView::Column(column))
    }

    fn geopoints(&self, field: &str) -> Option<GeoView<'_>> {
        let column = column_of(&self.payload.geopoint, field, |column| &column.field)?;
        Some(GeoView::Columns {
            documents: &column.documents,
            latitudes: &column.latitudes,
            longitudes: &column.longitudes,
        })
    }

    fn patterns(&self, field: &str) -> Option<PatternSource<'_>> {
        let column = column_of(&self.payload.pattern, field, |column| &column.field)?;
        Some(PatternSource::Index(PatternIndexRef::Column(column)))
    }

    fn for_each_text(
        &self,
        field: &str,
        ordinal: u32,
        visit: &mut dyn FnMut(&str) -> Result<bool>,
    ) -> Result<()> {
        let bytes = self.document_bytes(ordinal)?;
        match stored_field(&bytes, field)? {
            Some(value) => visit_stored_texts(value, visit),
            None => Ok(()),
        }
    }

    fn min_sort_value(&self, field: &str, ordinal: u32) -> Result<Option<SortValue<'_>>> {
        match self.document_bytes(ordinal)? {
            Cow::Borrowed(bytes) => match stored_field(bytes, field)? {
                Some(value) => stored_min_sort_value(value),
                None => Ok(None),
            },
            Cow::Owned(bytes) => match stored_field(&bytes, field)? {
                Some(value) => Ok(stored_min_sort_value(value)?.map(SortValue::into_owned)),
                None => Ok(None),
            },
        }
    }
}

impl FilterSource for TailSegment {
    fn capacity(&self) -> u32 {
        self.len() as u32
    }

    fn numeric(&self, field: &str) -> Option<NumericView<'_>> {
        let entries = self.columns.numeric.get(field)?;
        Some(NumericView::Unsorted(entries))
    }

    fn sizes(&self, field: &str) -> Option<NumericView<'_>> {
        let entries = self.columns.sizes.get(field)?;
        Some(NumericView::Unsorted(entries))
    }

    fn booleans(&self, field: &str) -> Option<BooleanView<'_>> {
        let (true_documents, false_documents) = self.columns.booleans.get(field)?;
        Some(BooleanView {
            true_documents,
            false_documents,
        })
    }

    fn enums(&self, field: &str) -> Option<EnumView<'_>> {
        self.columns.enums.get(field).map(EnumView::Map)
    }

    fn geopoints(&self, field: &str) -> Option<GeoView<'_>> {
        let points = self.columns.geopoints.get(field)?;
        Some(GeoView::Tuples(points))
    }

    fn patterns(&self, field: &str) -> Option<PatternSource<'_>> {
        let values = self.columns.patterns.get(field)?;
        Some(PatternSource::Values(values))
    }

    fn for_each_text(
        &self,
        field: &str,
        ordinal: u32,
        visit: &mut dyn FnMut(&str) -> Result<bool>,
    ) -> Result<()> {
        let value = self
            .documents
            .get(ordinal as usize)
            .and_then(|document| nested_value(document, field));
        match value {
            Some(value) => visit_value_texts(value, visit),
            None => Ok(()),
        }
    }

    fn min_sort_value(&self, field: &str, ordinal: u32) -> Result<Option<SortValue<'_>>> {
        Ok(self
            .documents
            .get(ordinal as usize)
            .and_then(|document| nested_value(document, field))
            .and_then(value_min_sort_value))
    }
}
