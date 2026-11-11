package vector

type flaggedDocuments struct {
	members  *orderedSet
	ordinals map[string]int32
	flag     uint32
}

func newFlaggedDocuments(flag uint32) *flaggedDocuments {
	return &flaggedDocuments{members: newOrderedSet(), ordinals: map[string]int32{}, flag: flag}
}

func (d *flaggedDocuments) size() int {
	return d.members.size()
}

func (d *flaggedDocuments) has(docID string) bool {
	return d.members.has(docID)
}

func (d *flaggedDocuments) values() []string {
	return d.members.values()
}

func (d *flaggedDocuments) mark(store *storeMemory, ordinal int32, on bool) {
	if d.flag == ordinalUnplaced {
		store.table.markUnplaced(ordinal, on)
		return
	}
	if on {
		store.table.setFlag(ordinal, d.flag)
		return
	}
	store.table.clearFlag(ordinal, d.flag)
}

func (d *flaggedDocuments) publishCount(store *storeMemory) {
	count := int64(d.members.size())
	if d.flag == ordinalUnplaced {
		store.unplacedCount.Store(count)
		store.word(storeWordUnplacedCount).Store(int32(count))
		return
	}
	store.removedCount.Store(count)
	store.word(storeWordRemovedCount).Store(int32(count))
}

func (d *flaggedDocuments) add(store *storeMemory, docID string) {
	d.members.add(docID)
	ordinal, held := store.ordinalOf(docID)
	previous, flagged := d.ordinals[docID]
	if held && (!flagged || previous != ordinal) {
		d.mark(store, ordinal, true)
		d.ordinals[docID] = ordinal
		if flagged {
			d.mark(store, previous, false)
		}
	}
	d.publishCount(store)
}

func (d *flaggedDocuments) delete(store *storeMemory, docID string) bool {
	held := d.members.delete(docID)
	if ordinal, flagged := d.ordinals[docID]; flagged {
		delete(d.ordinals, docID)
		d.mark(store, ordinal, false)
	}
	d.publishCount(store)
	return held
}

func (d *flaggedDocuments) clear(store *storeMemory) {
	d.members.clear()
	for _, ordinal := range d.ordinals {
		d.mark(store, ordinal, false)
	}
	clear(d.ordinals)
	d.publishCount(store)
}

func (d *flaggedDocuments) forget() {
	d.members.clear()
	clear(d.ordinals)
}
