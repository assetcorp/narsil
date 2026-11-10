package keyword

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
)

func FieldLengthsValue(columns []FieldLengthColumn) []any {
	values := make([]any, len(columns))
	for at, column := range columns {
		values[at] = map[string]any{"field": column.Field, "lengths": numbers(column.Lengths, form.WidthUint32)}
	}
	return values
}

func ValueColumnsValue(columns []ValueColumn) []any {
	values := make([]any, len(columns))
	for at, column := range columns {
		values[at] = map[string]any{
			"field":     column.Field,
			"documents": numbers(column.Documents, form.WidthUint32),
			"values":    numbers(column.Values, form.WidthFloat64),
		}
	}
	return values
}

func BooleanColumnsValue(columns []BooleanColumn) []any {
	values := make([]any, len(columns))
	for at, column := range columns {
		values[at] = map[string]any{
			"field":          column.Field,
			"trueDocuments":  numbers(column.TrueDocuments, form.WidthUint32),
			"falseDocuments": numbers(column.FalseDocuments, form.WidthUint32),
		}
	}
	return values
}

func EnumColumnsValue(columns []EnumColumn) []any {
	values := make([]any, len(columns))
	for at, column := range columns {
		values[at] = map[string]any{
			"field":     column.Field,
			"values":    form.StringValues(column.Values),
			"offsets":   numbers(column.Offsets, form.WidthUint32),
			"documents": numbers(column.Documents, form.WidthUint32),
		}
	}
	return values
}

func GeopointColumnsValue(columns []GeopointColumn) []any {
	values := make([]any, len(columns))
	for at, column := range columns {
		values[at] = map[string]any{
			"field":      column.Field,
			"documents":  numbers(column.Documents, form.WidthUint32),
			"latitudes":  numbers(column.Latitudes, form.WidthFloat64),
			"longitudes": numbers(column.Longitudes, form.WidthFloat64),
		}
	}
	return values
}

func PatternColumnsValue(columns []PatternColumn) []any {
	values := make([]any, len(columns))
	for at, column := range columns {
		values[at] = map[string]any{
			"field":     column.Field,
			"documents": numbers(column.Documents, form.WidthUint32),
			"runs":      numbers(column.Runs, form.WidthUint32),
			"offsets":   numbers(column.Offsets, form.WidthUint32),
			"postings":  numbers(column.Postings, form.WidthUint32),
		}
	}
	return values
}

func SurfaceFormsValue(column *SurfaceFormColumn) any {
	if column == nil {
		return nil
	}
	texts := TextEntries(column.Text, column.Offsets)
	pairs := make([]any, 0, len(texts)/2)
	for at := 0; at+1 < len(texts); at += 2 {
		pairs = append(pairs, []any{texts[at], texts[at+1]})
	}
	return map[string]any{"text": pairs, "counts": numbers(column.Counts, form.WidthUint32)}
}

func PartialWordsValue(column *PartialWordColumn) any {
	if column == nil {
		return nil
	}
	return map[string]any{
		"fields":     form.StringValues(column.Fields),
		"text":       TextEntries(column.Text, column.Offsets),
		"tokens":     numbers(column.Tokens, form.WidthUint32),
		"counts":     numbers(column.Counts, form.WidthUint32),
		"runs":       numbers(column.Runs, form.WidthUint32),
		"runOffsets": numbers(column.RunOffsets, form.WidthUint32),
		"runEntries": numbers(column.RunEntries, form.WidthUint32),
	}
}

func ColumnValues(segment *Segment) map[string]any {
	return map[string]any{
		"fieldLengths": FieldLengthsValue(segment.FieldLengths),
		"numeric":      ValueColumnsValue(segment.Numeric),
		"sizes":        ValueColumnsValue(segment.Sizes),
		"boolean":      BooleanColumnsValue(segment.Boolean),
		"enum":         EnumColumnsValue(segment.Enum),
		"geopoint":     GeopointColumnsValue(segment.Geopoint),
		"pattern":      PatternColumnsValue(segment.Pattern),
		"surfaceForms": SurfaceFormsValue(segment.SurfaceForms),
		"partialWords": PartialWordsValue(segment.PartialWords),
	}
}

func eachForm(fields *form.Fields, key string, take func(column *form.Fields)) {
	list := fields.List(key)
	for at := range list {
		take(fields.Element(list, key, at))
	}
}

func FieldLengthsFromForm(fields *form.Fields, key string) []FieldLengthColumn {
	columns := []FieldLengthColumn{}
	eachForm(fields, key, func(column *form.Fields) {
		columns = append(columns, FieldLengthColumn{
			Field:   column.String("field"),
			Lengths: column.NumberBytes("lengths", form.WidthUint32),
		})
	})
	return columns
}

func ValueColumnsFromForm(fields *form.Fields, key string) []ValueColumn {
	columns := []ValueColumn{}
	eachForm(fields, key, func(column *form.Fields) {
		columns = append(columns, ValueColumn{
			Field:     column.String("field"),
			Documents: column.NumberBytes("documents", form.WidthUint32),
			Values:    column.NumberBytes("values", form.WidthFloat64),
		})
	})
	return columns
}

func BooleanColumnsFromForm(fields *form.Fields, key string) []BooleanColumn {
	columns := []BooleanColumn{}
	eachForm(fields, key, func(column *form.Fields) {
		columns = append(columns, BooleanColumn{
			Field:          column.String("field"),
			TrueDocuments:  column.NumberBytes("trueDocuments", form.WidthUint32),
			FalseDocuments: column.NumberBytes("falseDocuments", form.WidthUint32),
		})
	})
	return columns
}

func EnumColumnsFromForm(fields *form.Fields, key string) []EnumColumn {
	columns := []EnumColumn{}
	eachForm(fields, key, func(column *form.Fields) {
		columns = append(columns, EnumColumn{
			Field:     column.String("field"),
			Values:    column.Strings("values"),
			Offsets:   column.NumberBytes("offsets", form.WidthUint32),
			Documents: column.NumberBytes("documents", form.WidthUint32),
		})
	})
	return columns
}

func GeopointColumnsFromForm(fields *form.Fields, key string) []GeopointColumn {
	columns := []GeopointColumn{}
	eachForm(fields, key, func(column *form.Fields) {
		columns = append(columns, GeopointColumn{
			Field:      column.String("field"),
			Documents:  column.NumberBytes("documents", form.WidthUint32),
			Latitudes:  column.NumberBytes("latitudes", form.WidthFloat64),
			Longitudes: column.NumberBytes("longitudes", form.WidthFloat64),
		})
	})
	return columns
}

func PatternColumnsFromForm(fields *form.Fields, key string) []PatternColumn {
	columns := []PatternColumn{}
	eachForm(fields, key, func(column *form.Fields) {
		columns = append(columns, PatternColumn{
			Field:     column.String("field"),
			Documents: column.NumberBytes("documents", form.WidthUint32),
			Runs:      column.NumberBytes("runs", form.WidthUint32),
			Offsets:   column.NumberBytes("offsets", form.WidthUint32),
			Postings:  column.NumberBytes("postings", form.WidthUint32),
		})
	})
	return columns
}

func SurfaceFormsFromForm(fields *form.Fields, key string) *SurfaceFormColumn {
	if !fields.HasValue(key) {
		return nil
	}
	column := fields.Object(key)
	pairs := column.List("text")
	entries := make([][]byte, 0, len(pairs)*2)
	for at, pair := range pairs {
		texts, isList := pair.([]any)
		if !isList || len(texts) != 2 {
			column.Fail(key+".text["+itoa(at)+"]", "is not a pair of strings")
			return nil
		}
		for _, text := range texts {
			spelling, isText := text.(string)
			if !isText {
				column.Fail(key+".text["+itoa(at)+"]", "is not a pair of strings")
				return nil
			}
			entries = append(entries, []byte(spelling))
		}
	}
	text, offsets := joinEntries(entries)
	return &SurfaceFormColumn{Text: text, Offsets: offsets, Counts: column.NumberBytes("counts", form.WidthUint32)}
}

func PartialWordsFromForm(fields *form.Fields, key string) *PartialWordColumn {
	if !fields.HasValue(key) {
		return nil
	}
	column := fields.Object(key)
	text, offsets := TextsFromForm(column, "text")
	return &PartialWordColumn{
		Fields:     column.Strings("fields"),
		Text:       text,
		Offsets:    offsets,
		Tokens:     column.NumberBytes("tokens", form.WidthUint32),
		Counts:     column.NumberBytes("counts", form.WidthUint32),
		Runs:       column.NumberBytes("runs", form.WidthUint32),
		RunOffsets: column.NumberBytes("runOffsets", form.WidthUint32),
		RunEntries: column.NumberBytes("runEntries", form.WidthUint32),
	}
}

func ColumnsFromForm(fields *form.Fields, segment *Segment) {
	segment.FieldLengths = FieldLengthsFromForm(fields, "fieldLengths")
	segment.Numeric = ValueColumnsFromForm(fields, "numeric")
	segment.Sizes = ValueColumnsFromForm(fields, "sizes")
	segment.Boolean = BooleanColumnsFromForm(fields, "boolean")
	segment.Enum = EnumColumnsFromForm(fields, "enum")
	segment.Geopoint = GeopointColumnsFromForm(fields, "geopoint")
	segment.Pattern = PatternColumnsFromForm(fields, "pattern")
	segment.SurfaceForms = SurfaceFormsFromForm(fields, "surfaceForms")
	segment.PartialWords = PartialWordsFromForm(fields, "partialWords")
}
