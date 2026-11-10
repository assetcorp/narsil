package fieldindex

import "sync/atomic"

type enumMember struct {
	slotPlusOne uint32
	position    uint32
}

type enumMemberKey struct {
	slot    uint32
	ordinal uint32
}

type enumPosting struct {
	value   string
	order   insertionOrder
	orderAt uint32
}

type EnumPosting struct {
	Value    string
	Ordinals []uint32
}

type Enum struct {
	postings     []enumPosting
	freeSlots    []uint32
	slots        map[string]uint32
	valueOrder   insertionOrder
	members      []enumMember
	extraMembers map[enumMemberKey]uint32
	affixes      atomic.Pointer[enumAffixes]
}

func NewEnum() *Enum {
	return &Enum{}
}

func (index *Enum) Insert(ordinal uint32, value string) {
	if ordinal == vacantOrdinal {
		return
	}
	index.addMember(index.slotFor(value), ordinal)
}

func (index *Enum) Remove(ordinal uint32, value string) {
	slot, held := index.slots[value]
	if !held {
		return
	}
	posting := &index.postings[slot]
	if position, member := index.memberPosition(slot, ordinal); member {
		posting.order.vacate(position)
		index.dropMember(slot, ordinal)
	}
	if posting.order.live == 0 {
		index.dropValue(slot)
		return
	}
	if posting.order.crowded() {
		posting.order.compact(func(moved, position uint32) { index.setMemberPosition(slot, moved, position) })
	}
}

func (index *Enum) Clear() {
	index.postings = nil
	index.freeSlots = nil
	index.slots = nil
	index.valueOrder = insertionOrder{}
	index.members = nil
	index.extraMembers = nil
	index.affixes.Store(nil)
}

func (index *Enum) Load(postings []EnumPosting) {
	index.Clear()
	for _, loaded := range postings {
		slot := index.slotFor(loaded.Value)
		index.emptyPosting(slot)
		for _, ordinal := range loaded.Ordinals {
			if ordinal != vacantOrdinal {
				index.addMember(slot, ordinal)
			}
		}
	}
}

func (index *Enum) EstimateBytes(documentCount int) int64 {
	return estimatedFieldBytes(documentCount)
}

func (index *Enum) slotFor(value string) uint32 {
	if slot, held := index.slots[value]; held {
		return slot
	}
	var slot uint32
	if free := len(index.freeSlots); free > 0 {
		slot = index.freeSlots[free-1]
		index.freeSlots = index.freeSlots[:free-1]
		index.postings[slot] = enumPosting{value: value}
	} else {
		slot = uint32(len(index.postings))
		index.postings = append(index.postings, enumPosting{value: value})
	}
	index.postings[slot].orderAt = index.valueOrder.push(slot)
	if index.slots == nil {
		index.slots = make(map[string]uint32)
	}
	index.slots[value] = slot
	index.affixes.Store(nil)
	return slot
}

func (index *Enum) dropValue(slot uint32) {
	posting := &index.postings[slot]
	delete(index.slots, posting.value)
	index.valueOrder.vacate(posting.orderAt)
	*posting = enumPosting{}
	index.freeSlots = append(index.freeSlots, slot)
	index.affixes.Store(nil)
	if index.valueOrder.crowded() {
		index.valueOrder.compact(index.movedValue)
	}
}

func (index *Enum) movedValue(slot, position uint32) {
	index.postings[slot].orderAt = position
}

func (index *Enum) emptyPosting(slot uint32) {
	posting := &index.postings[slot]
	for _, ordinal := range posting.order.ordinals {
		if ordinal != vacantOrdinal {
			index.dropMember(slot, ordinal)
		}
	}
	posting.order = insertionOrder{}
}

func (index *Enum) addMember(slot, ordinal uint32) {
	if _, member := index.memberPosition(slot, ordinal); member {
		return
	}
	position := index.postings[slot].order.push(ordinal)
	if int(ordinal) >= len(index.members) {
		index.members = append(index.members, make([]enumMember, int(ordinal)+1-len(index.members))...)
	}
	if index.members[ordinal].slotPlusOne == 0 {
		index.members[ordinal] = enumMember{slotPlusOne: slot + 1, position: position}
		return
	}
	index.setExtraMember(slot, ordinal, position)
}

func (index *Enum) setExtraMember(slot, ordinal, position uint32) {
	if index.extraMembers == nil {
		index.extraMembers = make(map[enumMemberKey]uint32)
	}
	index.extraMembers[enumMemberKey{slot: slot, ordinal: ordinal}] = position
}

func (index *Enum) memberPosition(slot, ordinal uint32) (uint32, bool) {
	if int(ordinal) < len(index.members) && index.members[ordinal].slotPlusOne == slot+1 {
		return index.members[ordinal].position, true
	}
	if len(index.extraMembers) == 0 {
		return 0, false
	}
	position, member := index.extraMembers[enumMemberKey{slot: slot, ordinal: ordinal}]
	return position, member
}

func (index *Enum) setMemberPosition(slot, ordinal, position uint32) {
	if int(ordinal) < len(index.members) && index.members[ordinal].slotPlusOne == slot+1 {
		index.members[ordinal].position = position
		return
	}
	index.setExtraMember(slot, ordinal, position)
}

func (index *Enum) dropMember(slot, ordinal uint32) {
	if int(ordinal) < len(index.members) && index.members[ordinal].slotPlusOne == slot+1 {
		index.members[ordinal] = enumMember{}
		return
	}
	delete(index.extraMembers, enumMemberKey{slot: slot, ordinal: ordinal})
}
