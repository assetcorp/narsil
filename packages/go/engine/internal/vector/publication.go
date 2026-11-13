package vector

import "sync/atomic"

type publicationHolds struct {
	count   atomic.Int64
	retired atomic.Bool
	release func()
}

func (h *publicationHolds) publish(release func()) {
	h.release = release
	h.count.Store(1)
}

func (h *publicationHolds) hold() bool {
	for {
		if h.retired.Load() {
			return false
		}
		held := h.count.Load()
		if held <= 0 {
			return false
		}
		if h.count.CompareAndSwap(held, held+1) {
			return true
		}
	}
}

func (h *publicationHolds) drop() {
	if h.count.Add(-1) == 0 {
		h.release()
	}
}

func (h *publicationHolds) retire() {
	if h.retired.CompareAndSwap(false, true) {
		h.drop()
	}
}
