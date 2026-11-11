package vector

type liveAtSequence struct {
	sequence int64
	live     int
}

func (s *storeMemory) countAdmitted(pin int64) int {
	admitted := 0
	for ordinal := range s.slots() {
		if s.admits(ordinal, pin) {
			admitted++
		}
	}
	return admitted
}

func (s *storeMemory) recordLive(sequence int64, live int) {
	var kept []liveAtSequence
	if held := s.liveBySequence.Load(); held != nil {
		kept = *held
	}
	if len(kept) > 0 {
		newest := kept[len(kept)-1].sequence
		if newest > sequence {
			s.forgetLive()
			return
		}
		if newest == sequence {
			kept = kept[:len(kept)-1]
		}
	}
	kept = kept[max(0, len(kept)+1-liveCountsKept):]
	next := make([]liveAtSequence, len(kept), len(kept)+1)
	copy(next, kept)
	next = append(next, liveAtSequence{sequence: sequence, live: live})
	s.liveBySequence.Store(&next)
}

func (s *storeMemory) forgetLive() {
	s.liveBySequence.Store(nil)
}

func (s *storeMemory) liveAt(pin int64) int {
	if held := s.liveBySequence.Load(); held != nil {
		kept := *held
		for at := len(kept) - 1; at >= 0; at-- {
			if kept[at].sequence <= pin {
				return kept[at].live
			}
		}
	}
	return s.countAdmitted(pin)
}

func liveAtPin(current *layout, pin int64) int {
	if current.store == nil {
		return 0
	}
	return current.store.liveAt(pin)
}

func (f *Field) recordCommittedLive(sequence int64) {
	if f.restoring > 0 || f.cold != nil {
		f.store.forgetLive()
		return
	}
	f.store.recordLive(sequence, f.liveSize())
}

func (f *Field) endRestoring() {
	f.restoring--
	f.recordAdmittedLive()
}

func (f *Field) recordAdmittedLive() {
	if f.disposed || f.restoring > 0 || f.cold != nil {
		return
	}
	sequence := max(f.slots.Sequence(), f.store.writeSequence().Load(), loadedWriteSequence)
	f.store.recordLive(sequence, f.store.countAdmitted(sequence))
}
