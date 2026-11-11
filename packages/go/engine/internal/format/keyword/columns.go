package keyword

type columnEntry struct {
	record map[string]any
	label  string
}

func (checker *Checker) eachColumn(raw any, name string) []columnEntry {
	list := checker.List(raw, name)
	entries := make([]columnEntry, 0, len(list))
	for at, element := range list {
		label := name + "[" + itoa(at) + "]"
		record := checker.Record(element, label)
		if checker.err != nil {
			return nil
		}
		entries = append(entries, columnEntry{record: record, label: label})
	}
	return entries
}

func (checker *Checker) uint32Column(record map[string]any, key string, label string) Uint32s {
	return checker.Bytes(record[key], label+"."+key, Uint32Bytes)
}

func (checker *Checker) ParseFieldLengths(raw any) []FieldLengthColumn {
	entries := checker.eachColumn(raw, "fieldLengths")
	columns := make([]FieldLengthColumn, 0, len(entries))
	for _, entry := range entries {
		columns = append(columns, FieldLengthColumn{
			Field:   checker.String(entry.record["field"], entry.label+".field"),
			Lengths: checker.uint32Column(entry.record, "lengths", entry.label),
		})
	}
	return columns
}

func (checker *Checker) ParseValueColumns(raw any, name string) []ValueColumn {
	entries := checker.eachColumn(raw, name)
	columns := make([]ValueColumn, 0, len(entries))
	for _, entry := range entries {
		columns = append(columns, ValueColumn{
			Field:     checker.String(entry.record["field"], entry.label+".field"),
			Documents: checker.uint32Column(entry.record, "documents", entry.label),
			Values:    checker.Bytes(entry.record["values"], entry.label+".values", Float64Bytes),
		})
	}
	return columns
}

func (checker *Checker) ParseBooleanColumns(raw any) []BooleanColumn {
	entries := checker.eachColumn(raw, "boolean")
	columns := make([]BooleanColumn, 0, len(entries))
	for _, entry := range entries {
		columns = append(columns, BooleanColumn{
			Field:          checker.String(entry.record["field"], entry.label+".field"),
			TrueDocuments:  checker.uint32Column(entry.record, "trueDocuments", entry.label),
			FalseDocuments: checker.uint32Column(entry.record, "falseDocuments", entry.label),
		})
	}
	return columns
}

func (checker *Checker) ParseEnumColumns(raw any) []EnumColumn {
	entries := checker.eachColumn(raw, "enum")
	columns := make([]EnumColumn, 0, len(entries))
	for _, entry := range entries {
		columns = append(columns, EnumColumn{
			Field:     checker.String(entry.record["field"], entry.label+".field"),
			Values:    checker.Strings(entry.record["values"], entry.label+".values"),
			Offsets:   checker.uint32Column(entry.record, "offsets", entry.label),
			Documents: checker.uint32Column(entry.record, "documents", entry.label),
		})
	}
	return columns
}

func (checker *Checker) ParseGeopointColumns(raw any) []GeopointColumn {
	entries := checker.eachColumn(raw, "geopoint")
	columns := make([]GeopointColumn, 0, len(entries))
	for _, entry := range entries {
		columns = append(columns, GeopointColumn{
			Field:      checker.String(entry.record["field"], entry.label+".field"),
			Documents:  checker.uint32Column(entry.record, "documents", entry.label),
			Latitudes:  checker.Bytes(entry.record["latitudes"], entry.label+".latitudes", Float64Bytes),
			Longitudes: checker.Bytes(entry.record["longitudes"], entry.label+".longitudes", Float64Bytes),
		})
	}
	return columns
}

func (checker *Checker) ParsePatternColumns(raw any) []PatternColumn {
	entries := checker.eachColumn(raw, "pattern")
	columns := make([]PatternColumn, 0, len(entries))
	for _, entry := range entries {
		columns = append(columns, PatternColumn{
			Field:     checker.String(entry.record["field"], entry.label+".field"),
			Documents: checker.uint32Column(entry.record, "documents", entry.label),
			Runs:      checker.Bytes(entry.record["runs"], entry.label+".runs", Uint32Bytes*CodePointsInRun),
			Offsets:   checker.uint32Column(entry.record, "offsets", entry.label),
			Postings:  checker.uint32Column(entry.record, "postings", entry.label),
		})
	}
	return columns
}

func (checker *Checker) ParseSurfaceForms(raw any) *SurfaceFormColumn {
	if raw == nil {
		return nil
	}
	record := checker.Record(raw, "surfaceForms")
	if checker.err != nil {
		return nil
	}
	return &SurfaceFormColumn{
		Text:    checker.Bytes(record["text"], "surfaceForms.text", 1),
		Offsets: checker.uint32Column(record, "offsets", "surfaceForms"),
		Counts:  checker.uint32Column(record, "counts", "surfaceForms"),
	}
}

func (checker *Checker) ParsePartialWords(raw any) *PartialWordColumn {
	if raw == nil {
		return nil
	}
	record := checker.Record(raw, "partialWords")
	if checker.err != nil {
		return nil
	}
	return &PartialWordColumn{
		Fields:     checker.Strings(record["fields"], "partialWords.fields"),
		Text:       checker.Bytes(record["text"], "partialWords.text", 1),
		Offsets:    checker.uint32Column(record, "offsets", "partialWords"),
		Tokens:     checker.uint32Column(record, "tokens", "partialWords"),
		Counts:     checker.uint32Column(record, "counts", "partialWords"),
		Runs:       checker.Bytes(record["runs"], "partialWords.runs", Uint32Bytes*CodePointsInRun),
		RunOffsets: checker.uint32Column(record, "runOffsets", "partialWords"),
		RunEntries: checker.uint32Column(record, "runEntries", "partialWords"),
	}
}
