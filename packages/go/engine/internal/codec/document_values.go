package codec

func DocumentFromMap(record map[string]any) *Document {
	if record == nil {
		return nil
	}
	state := newDocumentState()
	state.entries = make([]documentEntry, 0, len(record))
	for _, key := range ObjectKeyOrder(record) {
		state.entries = append(state.entries, documentEntry{key: key, value: adoptedValue(record[key])})
	}
	state.indexKeys()
	return &state.handle
}

func DocumentFromOrderedMap(entries OrderedMap) *Document {
	document := NewDocument()
	for _, entry := range entries {
		document.Set(entry.Key, entry.Value)
	}
	return document
}

func adoptedValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		if typed == nil {
			return nil
		}
		return DocumentFromMap(typed)
	case OrderedMap:
		return DocumentFromOrderedMap(typed)
	case []any:
		if typed == nil {
			return nil
		}
		adopted := make([]any, len(typed))
		for at, element := range typed {
			adopted[at] = adoptedValue(element)
		}
		return adopted
	case Document:
		return &typed
	case *Document:
		if typed == nil {
			return nil
		}
	}
	return value
}

func releasedValue(value any) any {
	switch typed := value.(type) {
	case []any:
		released := make([]any, len(typed))
		for at, element := range typed {
			released[at] = releasedValue(element)
		}
		return released
	case []byte:
		return append([]byte{}, typed...)
	case Extension:
		return Extension{Type: typed.Type, Data: append([]byte{}, typed.Data...)}
	}
	return value
}

func plainValue(value any) any {
	switch typed := value.(type) {
	case *Document:
		return typed.Map()
	case []any:
		plain := make([]any, len(typed))
		for at, element := range typed {
			plain[at] = plainValue(element)
		}
		return plain
	}
	return releasedValue(value)
}

// Map returns d as a map[string]any with every nested document as a map
// too. The map and each list in it are copies that hold no key order, and a
// nil document gives a nil map.
func (d *Document) Map() map[string]any {
	if d == nil {
		return nil
	}
	record := make(map[string]any, d.Len())
	for key, value := range HeldEntries(d) {
		record[key] = plainValue(value)
	}
	return record
}

func SnapshotValue(value any) any {
	switch typed := value.(type) {
	case *Document:
		return SnapshotDocument(typed)
	case []any:
		copied := make([]any, len(typed))
		for at, element := range typed {
			copied[at] = SnapshotValue(element)
		}
		return copied
	case []float32:
		return append([]float32{}, typed...)
	case []float64:
		return append([]float64{}, typed...)
	case []string:
		return append([]string{}, typed...)
	}
	return releasedValue(value)
}

func SnapshotDocument(document *Document) *Document {
	if document == nil {
		return nil
	}
	source := document.held
	state := newDocumentState()
	if source == nil {
		return &state.handle
	}
	if source.stored != nil && !source.changed {
		state.stored, state.shared, state.errorCode, state.depth = source.stored, source.shared, source.errorCode, source.depth
		return &state.handle
	}
	source.decoding.Do(source.decode)
	state.entries = make([]documentEntry, len(source.entries))
	for at, entry := range source.entries {
		copied := documentEntry{key: entry.key, value: SnapshotValue(entry.value)}
		if entry.raw != nil && !holdsChangedDocument(entry.value) {
			copied.raw = entry.raw
		}
		state.entries[at] = copied
	}
	state.indexKeys()
	state.adoptNested()
	return &state.handle
}

func (s *documentState) adoptNested() {
	for at := range s.entries {
		if s.entries[at].raw != nil {
			adoptStoredValue(s.entries[at].value, s)
		}
	}
}

func adoptStoredValue(value any, parent *documentState) {
	switch typed := value.(type) {
	case *Document:
		if typed.held != nil {
			typed.held.parent = parent
		}
	case []any:
		for _, element := range typed {
			adoptStoredValue(element, parent)
		}
	}
}

func holdsChangedDocument(value any) bool {
	switch typed := value.(type) {
	case *Document:
		return typed.held == nil || typed.held.stored == nil || typed.held.changed
	case []any:
		for _, element := range typed {
			if holdsChangedDocument(element) {
				return true
			}
		}
	}
	return false
}
