package core

/*
#include <stdlib.h>
#include "native/include/narsil_work.h"
*/
import "C"

import (
	"math"
	"sync/atomic"
	"unsafe"
)

const NoWorkCap int64 = math.MaxInt64

type workMeterWords struct {
	spent int64
	stop  uint32
	_     uint32
}

type WorkMeter struct {
	words    *workMeterWords
	cap      int64
	deadline uint64
}

func NewWorkMeter(cap int64, deadline uint64) (*WorkMeter, error) {
	words := (*workMeterWords)(C.calloc(1, C.size_t(unsafe.Sizeof(workMeterWords{}))))
	if words == nil {
		return nil, &StatusError{Operation: "createWorkMeter", Status: StatusOutOfMemory}
	}
	return &WorkMeter{words: words, cap: cap, deadline: deadline}, nil
}

func (m *WorkMeter) Spent() int64 {
	return atomic.LoadInt64(&m.words.spent)
}

func (m *WorkMeter) Stop() {
	atomic.StoreUint32(&m.words.stop, 1)
}

func (m *WorkMeter) Stopped() bool {
	return atomic.LoadUint32(&m.words.stop) != 0
}

func (m *WorkMeter) Cap() int64 {
	return m.cap
}

func (m *WorkMeter) Free() {
	if m.words != nil {
		C.free(unsafe.Pointer(m.words))
		m.words = nil
	}
}

func (m *WorkMeter) native() C.narsil_work_meter {
	return C.narsil_work_meter{
		spent:    (*C.int64_t)(unsafe.Pointer(&m.words.spent)),
		cap:      C.int64_t(m.cap),
		stop:     (*C.uint32_t)(unsafe.Pointer(&m.words.stop)),
		deadline: C.uint64_t(m.deadline),
	}
}

func ClockNow() uint64 {
	return uint64(C.narsil_clock_now())
}
