package codec

type faultyValue struct {
	failure error
	list    bool
}

func (s *documentState) noteFault(failure error) {
	if s.fault == nil {
		s.fault = failure
	}
}

func heldValueFault(value any) error {
	switch typed := value.(type) {
	case faultyValue:
		return typed.failure
	case *Document:
		if typed != nil && typed.held != nil {
			return typed.held.fault
		}
	case []any:
		for _, element := range typed {
			if failure := heldValueFault(element); failure != nil {
				return failure
			}
		}
	}
	return nil
}

func StoredPathFailure(document *Document, path []string, listsReadWholeDocument bool) error {
	state := document.readable()
	if state == nil || state.firstFailure() == nil || readsPathWithoutFault(document, path, listsReadWholeDocument) {
		return nil
	}
	return StoredDocumentFailure(document)
}

func readsPathWithoutFault(document *Document, path []string, listsReadWholeDocument bool) bool {
	current := document
	for at, segment := range path {
		state := current.readable()
		if state == nil {
			return true
		}
		if state.failure != nil {
			return false
		}
		position, known := state.position(segment)
		if !known {
			return true
		}
		value := state.entries[position].value
		if at == len(path)-1 {
			return heldValueFault(value) == nil
		}
		switch typed := value.(type) {
		case *Document:
			current = typed
		case []any:
			return !listsReadWholeDocument
		case faultyValue:
			return typed.list && !listsReadWholeDocument
		case nil, bool, float64, string, []float32:
			return true
		default:
			return false
		}
	}
	return true
}
