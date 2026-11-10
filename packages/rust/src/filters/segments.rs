use super::source::{BooleanView, EnumView, FilterSource, GeoView, NumericView};
use crate::index::frozen::FrozenSegment;
use crate::index::tail::TailSegment;

fn column_of<'a, C>(columns: &'a [C], field: &str, field_of: impl Fn(&C) -> &str) -> Option<&'a C> {
    columns.iter().find(|column| field_of(column) == field)
}

impl FilterSource for FrozenSegment {
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
}

impl FilterSource for TailSegment {
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
}
