package partition

import "sync/atomic"

type readFailure struct {
	held atomic.Pointer[error]
}

func (f *readFailure) record(err error) {
	if f == nil || err == nil {
		return
	}
	f.held.CompareAndSwap(nil, &err)
}

func (f *readFailure) err() error {
	if f == nil {
		return nil
	}
	if held := f.held.Load(); held != nil {
		return *held
	}
	return nil
}

func (v View) ReadFailure() error {
	return v.failure.err()
}

func (v View) DocumentRead(id string) (*StoredDocument, uint32, bool, error) {
	if !v.HoldsFrozenSegments() {
		document, ordinal, found := v.state.documents.get(id)
		return document, ordinal, found, nil
	}
	layout := v.layout()
	for at, sub := range v.state.frozen {
		if ordinal, found := sub.holdsLive(id); found {
			document, err := sub.segment.DocumentAt(ordinal)
			if err != nil {
				return nil, 0, false, err
			}
			return document, layout.bases[at] + ordinal, document != nil, nil
		}
	}
	document, ordinal, found := v.state.documents.get(id)
	return document, layout.bases[len(layout.bases)-1] + ordinal, found, nil
}

func (v View) DocumentAtRead(ordinal uint32) (*StoredDocument, error) {
	if !v.HoldsFrozenSegments() {
		return v.state.documents.at(ordinal), nil
	}
	sources := v.sources()
	at, local := layoutOf(sources).locate(ordinal)
	if local >= sources[at].ordinalCapacity() {
		return nil, nil
	}
	return sources[at].documentAt(local)
}

func (v View) EachDocument(visit func(ordinal uint32, document *StoredDocument) bool) error {
	if !v.HoldsFrozenSegments() {
		v.state.documents.forEach(visit)
		return nil
	}
	layout := v.layout()
	for at, sub := range v.state.frozen {
		for ordinal := uint32(0); ordinal < sub.ordinalCapacity(); ordinal++ {
			document, err := sub.documentAt(ordinal)
			if err != nil {
				return err
			}
			if document != nil && !visit(layout.bases[at]+ordinal, document) {
				return nil
			}
		}
	}
	base := layout.bases[len(layout.bases)-1]
	v.state.documents.forEach(func(ordinal uint32, document *StoredDocument) bool {
		return visit(base+ordinal, document)
	})
	return nil
}

func (v View) IDAt(ordinal uint32) (string, bool) {
	if !v.HoldsFrozenSegments() {
		return v.state.idAt(ordinal)
	}
	sources := v.sources()
	at, local := layoutOf(sources).locate(ordinal)
	if local >= sources[at].ordinalCapacity() {
		return "", false
	}
	return sources[at].idAt(local)
}
