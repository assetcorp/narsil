package keyword

func (chunks *Chunks) field(name string) {
	chunks.Key("field")
	chunks.Key(name)
}

func (chunks *Chunks) entry(key string, data []byte) {
	chunks.Key(key)
	chunks.Binary(data)
}

func (chunks *Chunks) FieldLengths(columns []FieldLengthColumn) {
	chunks.Array(len(columns))
	for _, column := range columns {
		chunks.Map(2)
		chunks.field(column.Field)
		chunks.entry("lengths", column.Lengths)
	}
}

func (chunks *Chunks) ValueColumns(columns []ValueColumn) {
	chunks.Array(len(columns))
	for _, column := range columns {
		chunks.Map(3)
		chunks.field(column.Field)
		chunks.entry("documents", column.Documents)
		chunks.entry("values", column.Values)
	}
}

func (chunks *Chunks) BooleanColumns(columns []BooleanColumn) {
	chunks.Array(len(columns))
	for _, column := range columns {
		chunks.Map(3)
		chunks.field(column.Field)
		chunks.entry("trueDocuments", column.TrueDocuments)
		chunks.entry("falseDocuments", column.FalseDocuments)
	}
}

func (chunks *Chunks) EnumColumns(columns []EnumColumn) {
	chunks.Array(len(columns))
	for _, column := range columns {
		chunks.Map(4)
		chunks.field(column.Field)
		chunks.Key("values")
		chunks.Strings(column.Values)
		chunks.entry("offsets", column.Offsets)
		chunks.entry("documents", column.Documents)
	}
}

func (chunks *Chunks) GeopointColumns(columns []GeopointColumn) {
	chunks.Array(len(columns))
	for _, column := range columns {
		chunks.Map(4)
		chunks.field(column.Field)
		chunks.entry("documents", column.Documents)
		chunks.entry("latitudes", column.Latitudes)
		chunks.entry("longitudes", column.Longitudes)
	}
}

func (chunks *Chunks) PatternColumns(columns []PatternColumn) {
	chunks.Array(len(columns))
	for _, column := range columns {
		chunks.Map(5)
		chunks.field(column.Field)
		chunks.entry("documents", column.Documents)
		chunks.entry("runs", column.Runs)
		chunks.entry("offsets", column.Offsets)
		chunks.entry("postings", column.Postings)
	}
}

func (chunks *Chunks) SurfaceForms(column *SurfaceFormColumn) {
	if column == nil {
		chunks.Nil()
		return
	}
	chunks.Map(3)
	chunks.entry("text", column.Text)
	chunks.entry("offsets", column.Offsets)
	chunks.entry("counts", column.Counts)
}

func (chunks *Chunks) PartialWords(column *PartialWordColumn) {
	if column == nil {
		chunks.Nil()
		return
	}
	chunks.Map(8)
	chunks.Key("fields")
	chunks.Strings(column.Fields)
	chunks.entry("text", column.Text)
	chunks.entry("offsets", column.Offsets)
	chunks.entry("tokens", column.Tokens)
	chunks.entry("counts", column.Counts)
	chunks.entry("runs", column.Runs)
	chunks.entry("runOffsets", column.RunOffsets)
	chunks.entry("runEntries", column.RunEntries)
}
