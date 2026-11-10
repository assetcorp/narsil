package vector

type Write struct {
	DocID     string
	Values    []float32
	Partition int32
	Remove    bool
}

func (f *Field) ApplyWrites(writes []Write) []error {
	var failures []error
	_ = f.slots.Write(func(sequence int64) error {
		failures = f.ApplyWritesAt(sequence, writes)
		f.PublishSequence(sequence)
		return nil
	})
	return failures
}

func (f *Field) ApplyWritesAt(sequence int64, writes []Write) []error {
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
			failures[at] = f.removeLocked(write.DocID, sequence)
			continue
		}
		failures[at] = f.insertLocked(write.DocID, write.Values, write.Partition, sequence)
	}
	return failures
}

func (f *Field) PublishSequence(sequence int64) {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if !f.disposed {
		f.store.publishSequence(sequence)
		f.recordCommittedLive(sequence)
		if f.cold != nil {
			f.cold.commit(sequence, f)
		}
	}
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

func applyField(sequence int64, named NamedField, documents []DocumentVectors, failures []error) {
	owners := make([]int, 0, len(documents))
	writes := make([]Write, 0, len(documents))
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
	for at, err := range named.Field.ApplyWritesAt(sequence, writes) {
		if err != nil {
			failures[owners[at]] = err
		}
	}
}

func ApplyDocumentsAt(sequence int64, fields []NamedField, documents []DocumentVectors, failures []error) {
	for _, named := range fields {
		applyField(sequence, named, documents, failures)
	}
	for _, named := range fields {
		named.Field.PublishSequence(sequence)
	}
}

func RemovalsOf(docIDs []string) []DocumentVectors {
	removals := make([]DocumentVectors, len(docIDs))
	for at, docID := range docIDs {
		removals[at] = DocumentVectors{DocID: docID, Remove: true}
	}
	return removals
}
