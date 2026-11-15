package memory

import (
	"syscall"
	"unsafe"
)

type processMemoryCountersEx2 struct {
	size                       uint32
	pageFaultCount             uint32
	peakWorkingSetSize         uintptr
	workingSetSize             uintptr
	quotaPeakPagedPoolUsage    uintptr
	quotaPagedPoolUsage        uintptr
	quotaPeakNonPagedPoolUsage uintptr
	quotaNonPagedPoolUsage     uintptr
	pagefileUsage              uintptr
	peakPagefileUsage          uintptr
	privateUsage               uintptr
	privateWorkingSetSize      uintptr
	sharedCommitUsage          uint64
}

type memoryStatusEx struct {
	length                uint32
	memoryLoad            uint32
	totalPhysical         uint64
	availablePhysical     uint64
	totalPageFile         uint64
	availablePageFile     uint64
	totalVirtual          uint64
	availableVirtual      uint64
	availableExtendedVirt uint64
}

const currentProcessPseudoHandle = ^uintptr(0)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	getProcessMemoryInfo    = kernel32.NewProc("K32GetProcessMemoryInfo")
	globalMemoryStatusEx    = kernel32.NewProc("GlobalMemoryStatusEx")
	processMemoryCountersV1 = unsafe.Offsetof(processMemoryCountersEx2{}.privateUsage)
)

func memoryCounters(size uintptr) (processMemoryCountersEx2, bool) {
	counters := processMemoryCountersEx2{size: uint32(size)}
	if getProcessMemoryInfo.Find() != nil {
		return counters, false
	}
	succeeded, _, _ := getProcessMemoryInfo.Call(currentProcessPseudoHandle, uintptr(unsafe.Pointer(&counters)), size)
	return counters, succeeded != 0
}

func platformProcessBytes() (uint64, bool) {
	counters, found := memoryCounters(unsafe.Sizeof(processMemoryCountersEx2{}))
	if !found {
		counters, found = memoryCounters(processMemoryCountersV1)
		counters.privateWorkingSetSize = 0
	}
	if !found {
		return 0, false
	}
	if counters.privateWorkingSetSize != 0 {
		return uint64(counters.privateWorkingSetSize), true
	}
	return uint64(counters.workingSetSize), true
}

func platformLimitBytes(uint64) (uint64, bool) {
	status := memoryStatusEx{length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	if globalMemoryStatusEx.Find() != nil {
		return 0, false
	}
	succeeded, _, _ := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status)))
	if succeeded == 0 || status.totalPhysical == 0 {
		return 0, false
	}
	return status.totalPhysical, true
}
