package vector

import "github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"

type retiredPins struct {
	count   int
	lost    bool
	retired map[int32]struct{}
}

func (p *retiredPins) pin() {
	p.count++
}

func (p *retiredPins) unpin() {
	if p.count == 0 {
		return
	}
	p.count--
	if p.count > 0 {
		return
	}
	clear(p.retired)
	p.lost = false
}

func (p *retiredPins) note(ordinal int32) {
	if p.count > 0 {
		p.retired[ordinal] = struct{}{}
	}
}

func (p *retiredPins) holds(ordinal int32) bool {
	_, held := p.retired[ordinal]
	return held
}

func (p *retiredPins) forget() {
	clear(p.retired)
	if p.count > 0 {
		p.lost = true
	}
}

func (p *retiredPins) requireIntact() error {
	if !p.lost {
		return nil
	}
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
		"The vector store was emptied while a checkpoint read the vectors it captured, so the checkpoint stops", nil)
}

func (s *storeMemory) keptOrdinals() map[int32]struct{} {
	kept := make(map[int32]struct{}, len(s.replaced)+len(s.pins.retired))
	for ordinal := range s.replaced {
		kept[ordinal] = struct{}{}
	}
	for ordinal := range s.pins.retired {
		kept[ordinal] = struct{}{}
	}
	return kept
}

func (s *storeMemory) readStoredVector(tables *storeTables, ordinal int32, target []float32) bool {
	if ordinal < 0 || ordinal >= s.slots() || len(target) < s.dimension {
		return false
	}
	if s.isCold(ordinal) {
		return s.vectorFromFile(tables, ordinal, target)
	}
	slot := s.vectorSlot(tables, ordinal)
	if slot == nil {
		return false
	}
	copy(target, slot)
	return true
}

func (s *storeMemory) readPinnedVector(ordinal int32, target []float32) (bool, error) {
	if err := s.pins.requireIntact(); err != nil {
		return false, err
	}
	if !s.readable(ordinal) && !s.pins.holds(ordinal) {
		return false, nil
	}
	return s.readStoredVector(s.tables, ordinal, target), nil
}
