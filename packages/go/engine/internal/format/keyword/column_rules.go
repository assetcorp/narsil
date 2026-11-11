package keyword

func (checker *Checker) Width(values []byte, width int, name string) {
	if checker.err == nil && len(values)%width != 0 {
		checker.Fail(name+" holds "+itoa(len(values))+" bytes, which is not a whole number of "+itoa(width)+
			"-byte values", map[string]any{"field": name})
	}
}

func (checker *Checker) ordinalColumn(values Uint32s, documentCount uint32, name string) {
	checker.Width(values, Uint32Bytes, name)
	checker.Ordinals(values, documentCount, name)
}

func columnLabel(name string, at int, key string) string {
	return name + "[" + itoa(at) + "]." + key
}

func (checker *Checker) CheckFieldLengths(columns []FieldLengthColumn, documentCount uint32) {
	for at, column := range columns {
		label := columnLabel("fieldLengths", at, "lengths")
		checker.Width(column.Lengths, Uint32Bytes, label)
		checker.Count(column.Lengths.Len(), int(documentCount), label)
	}
}

func (checker *Checker) CheckValueColumns(columns []ValueColumn, name string, documentCount uint32) {
	for at, column := range columns {
		checker.ordinalColumn(column.Documents, documentCount, columnLabel(name, at, "documents"))
		label := columnLabel(name, at, "values")
		checker.Width(column.Values, Float64Bytes, label)
		checker.Count(column.Values.Len(), column.Documents.Len(), label)
		checker.ValuesAscendWithoutNaN(column.Values, label)
	}
}

func (checker *Checker) CheckBooleanColumns(columns []BooleanColumn, documentCount uint32) {
	for at, column := range columns {
		checker.ordinalColumn(column.TrueDocuments, documentCount, columnLabel("boolean", at, "trueDocuments"))
		checker.ordinalColumn(column.FalseDocuments, documentCount, columnLabel("boolean", at, "falseDocuments"))
	}
}

func (checker *Checker) CheckEnumColumns(columns []EnumColumn, documentCount uint32) {
	for at, column := range columns {
		seen := make(map[string]struct{}, len(column.Values))
		for _, value := range column.Values {
			if _, repeated := seen[value]; repeated {
				checker.Fail(columnLabel("enum", at, "values")+" names a value twice", nil)
				return
			}
			seen[value] = struct{}{}
		}
		offsetsLabel := columnLabel("enum", at, "offsets")
		checker.Width(column.Offsets, Uint32Bytes, offsetsLabel)
		checker.ordinalColumn(column.Documents, documentCount, columnLabel("enum", at, "documents"))
		checker.Count(column.Offsets.Len(), len(column.Values)+1, offsetsLabel)
		checker.Offsets(column.Offsets, column.Documents.Len(), offsetsLabel)
	}
}

func (checker *Checker) CheckGeopointColumns(columns []GeopointColumn, documentCount uint32) {
	for at, column := range columns {
		checker.ordinalColumn(column.Documents, documentCount, columnLabel("geopoint", at, "documents"))
		latitudes := columnLabel("geopoint", at, "latitudes")
		longitudes := columnLabel("geopoint", at, "longitudes")
		checker.Width(column.Latitudes, Float64Bytes, latitudes)
		checker.Width(column.Longitudes, Float64Bytes, longitudes)
		checker.Count(column.Latitudes.Len(), column.Documents.Len(), latitudes)
		checker.Count(column.Longitudes.Len(), column.Documents.Len(), longitudes)
		checker.Within(column.Latitudes, -MaxLatitudeDegrees, MaxLatitudeDegrees, latitudes)
		checker.Within(column.Longitudes, -MaxLongitudeDegrees, MaxLongitudeDegrees, longitudes)
	}
}

func (checker *Checker) CheckPatternColumns(columns []PatternColumn, documentCount uint32) {
	for at, column := range columns {
		documents := columnLabel("pattern", at, "documents")
		checker.ordinalColumn(column.Documents, documentCount, documents)
		checker.StrictlyAscending(column.Documents, 0, column.Documents.Len(), documents)
		runs := columnLabel("pattern", at, "runs")
		checker.Width(column.Runs, Uint32Bytes*CodePointsInRun, runs)
		checker.RunsAscend(column.Runs, runs)
		offsets := columnLabel("pattern", at, "offsets")
		checker.Width(column.Offsets, Uint32Bytes, offsets)
		postings := columnLabel("pattern", at, "postings")
		checker.ordinalColumn(column.Postings, documentCount, postings)
		checker.Count(column.Offsets.Len(), column.Runs.Len()/CodePointsInRun+1, offsets)
		checker.Offsets(column.Offsets, column.Postings.Len(), offsets)
		if checker.err != nil {
			return
		}
		for run := 0; run+1 < column.Offsets.Len(); run++ {
			checker.StrictlyAscending(column.Postings, int(column.Offsets.At(run)), int(column.Offsets.At(run+1)), postings)
		}
	}
}

func (checker *Checker) CheckSurfaceForms(column *SurfaceFormColumn) {
	if column == nil {
		return
	}
	checker.Width(column.Offsets, Uint32Bytes, "surfaceForms.offsets")
	checker.Width(column.Counts, Uint32Bytes, "surfaceForms.counts")
	checker.Count(column.Offsets.Len(), column.Counts.Len()*2+1, "surfaceForms.offsets")
	checker.Offsets(column.Offsets, len(column.Text), "surfaceForms.offsets")
	checker.UTF8Entries(column.Text, column.Offsets, "surfaceForms.text")
}

func (checker *Checker) CheckPartialWords(column *PartialWordColumn, tokenCount int) {
	if column == nil {
		return
	}
	for _, values := range []struct {
		bytes []byte
		width int
		name  string
	}{
		{column.Offsets, Uint32Bytes, "partialWords.offsets"},
		{column.Tokens, Uint32Bytes, "partialWords.tokens"},
		{column.Counts, Uint32Bytes, "partialWords.counts"},
		{column.Runs, Uint32Bytes * CodePointsInRun, "partialWords.runs"},
		{column.RunOffsets, Uint32Bytes, "partialWords.runOffsets"},
		{column.RunEntries, Uint32Bytes, "partialWords.runEntries"},
	} {
		checker.Width(values.bytes, values.width, values.name)
	}
	entries := column.Tokens.Len()
	checker.Count(column.Offsets.Len(), entries+1, "partialWords.offsets")
	checker.Count(column.Counts.Len(), entries, "partialWords.counts")
	checker.Offsets(column.Offsets, len(column.Text), "partialWords.offsets")
	checker.UTF8Entries(column.Text, column.Offsets, "partialWords.text")
	checker.Below(column.Tokens, uint32(min(max(tokenCount, 0), MaxDocumentCountValue)), "partialWords.tokens")
	checker.NonZero(column.Counts, "partialWords.counts")
	checker.SpellingEntriesAscend(column.Text, column.Offsets, column.Tokens, "partialWords")
	checker.RunsAscend(column.Runs, "partialWords.runs")
	checker.Count(column.RunOffsets.Len(), column.Runs.Len()/CodePointsInRun+1, "partialWords.runOffsets")
	checker.Offsets(column.RunOffsets, column.RunEntries.Len(), "partialWords.runOffsets")
	checker.Below(column.RunEntries, uint32(min(entries, MaxDocumentCountValue)), "partialWords.runEntries")
	if checker.err != nil {
		return
	}
	for run := 0; run+1 < column.RunOffsets.Len(); run++ {
		checker.StrictlyAscending(column.RunEntries, int(column.RunOffsets.At(run)), int(column.RunOffsets.At(run+1)),
			"partialWords.runEntries")
	}
}
