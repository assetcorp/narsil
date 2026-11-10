package vector

type Write struct {
	DocID     string
	Values    []float32
	Partition int32
	Remove    bool
}

func (f *Field) ApplyWrites(writes []Write) []error {
	failures := make([]error, len(writes))
	for at, write := range writes {
		if !write.Remove {
			failures[at] = f.validateVector(write.DocID, write.Values)
		}
	}
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	for at, write := range writes {
		if failures[at] != nil {
			continue
		}
		if write.Remove {
			failures[at] = f.removeLocked(write.DocID)
			continue
		}
		failures[at] = f.insertLocked(write.DocID, write.Values, write.Partition)
	}
	return failures
}

type NamedField struct {
	Path  string
	Field *Field
}

type DocumentVectors struct {
	DocID     string
	Vectors   map[string][]float32
	Partition int32
	Remove    bool
}

func ApplyDocuments(fields []NamedField, documents []DocumentVectors, failures []error) {
	owners := make([]int, 0, len(documents))
	writes := make([]Write, 0, len(documents))
	for _, named := range fields {
		owners, writes = owners[:0], writes[:0]
		for at, document := range documents {
			if failures[at] != nil {
				continue
			}
			values, present := document.Vectors[named.Path]
			owners = append(owners, at)
			writes = append(writes, Write{DocID: document.DocID, Values: values, Partition: document.Partition,
				Remove: document.Remove || !present})
		}
		if len(writes) == 0 {
			return
		}
		for at, err := range named.Field.ApplyWrites(writes) {
			if err != nil {
				failures[owners[at]] = err
			}
		}
	}
}

func RemoveDocuments(fields []NamedField, docIDs []string) {
	if len(docIDs) == 0 {
		return
	}
	writes := make([]Write, len(docIDs))
	for at, docID := range docIDs {
		writes[at] = Write{DocID: docID, Remove: true}
	}
	for _, named := range fields {
		_ = named.Field.ApplyWrites(writes)
	}
}
