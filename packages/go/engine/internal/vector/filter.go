package vector

type Filter struct {
	docIDs       []string
	partitions   map[int32]struct{}
	byPartitions bool
}

func AcceptDocIDs(docIDs []string) *Filter {
	return &Filter{docIDs: append([]string(nil), docIDs...)}
}

func AcceptPartitions(partitions []int32) *Filter {
	accepted := make(map[int32]struct{}, len(partitions))
	for _, partition := range partitions {
		if partition >= 0 {
			accepted[partition] = struct{}{}
		}
	}
	return &Filter{partitions: accepted, byPartitions: true}
}

type ordinalFilter struct {
	bits  []byte
	count int
}

func newOrdinalFilter(slots int32) *ordinalFilter {
	return &ordinalFilter{bits: make([]byte, (int(slots)+7)>>3)}
}

func (o *ordinalFilter) add(ordinal int32) {
	index := int(ordinal) >> 3
	if ordinal < 0 || index >= len(o.bits) {
		return
	}
	bit := byte(1) << (ordinal & 7)
	if o.bits[index]&bit != 0 {
		return
	}
	o.bits[index] |= bit
	o.count++
}

func (o *ordinalFilter) has(ordinal int32) bool {
	index := int(ordinal) >> 3
	if ordinal < 0 || index >= len(o.bits) {
		return false
	}
	return o.bits[index]&(byte(1)<<(ordinal&7)) != 0
}

func (o *ordinalFilter) each(visit func(ordinal int32) bool) {
	for index, value := range o.bits {
		if value == 0 {
			continue
		}
		for offset := range 8 {
			if value&(byte(1)<<offset) != 0 && !visit(int32(index<<3|offset)) {
				return
			}
		}
	}
}

func liveOrdinal(store *storeMemory, ordinal int32) bool {
	return store.table.flags(ordinal)&(ordinalHoldsDocument|ordinalRemoved) == ordinalHoldsDocument
}

func filterOf(current *layout, filter *Filter, pin int64) *ordinalFilter {
	if filter == nil {
		return nil
	}
	store := current.store
	slots := store.slots()
	accepted := newOrdinalFilter(slots)
	if !filter.byPartitions {
		for _, docID := range filter.docIDs {
			ordinal, held := store.admittedOrdinalOf(docID, pin)
			if held && ordinal < slots {
				accepted.add(ordinal)
			}
		}
		return accepted
	}
	if len(filter.partitions) == 0 {
		return accepted
	}
	for ordinal := range slots {
		if !store.admits(ordinal, pin) {
			continue
		}
		if _, wanted := filter.partitions[store.table.partition(ordinal)]; wanted {
			accepted.add(ordinal)
		}
	}
	return accepted
}
