package codec

import "encoding/binary"

const (
	negativeZeroFloat64Bits = 1 << 63
	negativeZeroFloat32Bits = 1 << 31
)

func (state encoder) appendDocument(destination []byte, document *Document, depth int) ([]byte, error) {
	if document == nil {
		return AppendNil(destination), nil
	}
	held := document.held
	if held == nil {
		return AppendMapHeader(destination, 0), nil
	}
	fromStored := !state.options.FromValues
	if fromStored && held.stored != nil && !held.changed {
		return append(destination, held.stored...), nil
	}
	held.decoding.Do(held.decode)
	if held.failure != nil {
		return destination, held.failure
	}
	if err := state.requireLength(len(held.entries), "map object"); err != nil {
		return destination, err
	}
	destination = AppendMapHeader(destination, len(held.entries))
	var err error
	for at := range held.entries {
		entry := &held.entries[at]
		destination = AppendString(destination, entry.key)
		if fromStored && entry.raw != nil && !holdsChangedDocument(entry.value) {
			destination = append(destination, entry.raw...)
			continue
		}
		if destination, err = state.appendValue(destination, entry.value, depth+1); err != nil {
			return destination, err
		}
	}
	return destination, nil
}

func documentHoldsNegativeZero(document *Document, depth int) bool {
	if document == nil || document.held == nil {
		return false
	}
	held := document.held
	if held.stored != nil && !held.changed {
		return storedHoldsNegativeZero(held.stored)
	}
	held.decoding.Do(held.decode)
	for at := range held.entries {
		if HoldsNegativeZero(held.entries[at].value, depth+1) {
			return true
		}
	}
	return false
}

func storedHoldsNegativeZero(stored []byte) bool {
	decoder := NewDecoder(stored, DecodeOptions{})
	for pending := 1; pending > 0; pending-- {
		tag, err := decoder.peekTag()
		if err != nil {
			return false
		}
		at := decoder.position + 1
		switch {
		case tag == tagFloat64 && len(stored)-at >= 8:
			if binary.BigEndian.Uint64(stored[at:]) == negativeZeroFloat64Bits {
				return true
			}
		case tag == tagFloat32 && len(stored)-at >= 4:
			if binary.BigEndian.Uint32(stored[at:]) == negativeZeroFloat32Bits {
				return true
			}
		}
		children, err := decoder.skipOne()
		if err != nil || children > decoder.Remaining() {
			return false
		}
		pending += children
	}
	return false
}

func StoredBytes(document *Document) ([]byte, bool) {
	if document == nil || document.held == nil || document.held.stored == nil || document.held.changed {
		return nil, false
	}
	return document.held.stored, true
}
