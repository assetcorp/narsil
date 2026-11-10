package storage

import (
	"encoding/binary"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"
)

const (
	auxvClockTicksType        = 17
	auxvEndType               = 0
	firstStatFieldAfterName   = 3
	statStateField            = 3
	statStartTimeField        = 22
	millisecondsPerSecond     = 1000
	exitedStates              = "ZXx"
	processKindUnknown        = 0
	processKindProcess        = 1
	processKindThread         = 2
	processKindExited         = 3
	procDirectory             = "/proc/"
	procUptimePath            = "/proc/uptime"
	procSelfAuxvPath          = "/proc/self/auxv"
	threadGroupLinePrefixText = "Tgid:"
)

var (
	clockTicksOnce  sync.Once
	clockTicksValue float64
	threadGroupLine = regexp.MustCompile(`(?m)^` + threadGroupLinePrefixText + `\s*(\d+)\s*$`)
)

func clockTicksPerSecond() float64 {
	clockTicksOnce.Do(func() {
		auxv, err := os.ReadFile(procSelfAuxvPath)
		if err != nil {
			return
		}
		wordBytes := int(unsafe.Sizeof(uintptr(0)))
		for offset := 0; offset+2*wordBytes <= len(auxv); offset += 2 * wordBytes {
			kind := readWord(auxv[offset:], wordBytes)
			if kind == auxvEndType {
				return
			}
			if kind == auxvClockTicksType {
				if ticks := readWord(auxv[offset+wordBytes:], wordBytes); ticks > 0 {
					clockTicksValue = float64(ticks)
				}
				return
			}
		}
	})
	return clockTicksValue
}

func readWord(data []byte, wordBytes int) uint64 {
	if wordBytes == 8 {
		return binary.NativeEndian.Uint64(data)
	}
	return uint64(binary.NativeEndian.Uint32(data))
}

type processIdentity struct {
	kind    int
	startMs int64
}

func identifyProcess(pid int) processIdentity {
	base := procDirectory + strconv.Itoa(pid)
	status, err := os.ReadFile(base + "/status")
	if err != nil {
		return processIdentity{}
	}
	stat, err := os.ReadFile(base + "/stat")
	if err != nil {
		return processIdentity{}
	}
	leader := threadGroupLine.FindSubmatch(status)
	if leader == nil {
		return processIdentity{}
	}
	if string(leader[1]) != strconv.Itoa(pid) {
		return processIdentity{kind: processKindThread}
	}
	commandEnd := strings.LastIndexByte(string(stat), ')')
	if commandEnd < 0 {
		return processIdentity{}
	}
	fields := strings.Fields(string(stat[commandEnd+1:]))
	if index := statStateField - firstStatFieldAfterName; index < len(fields) &&
		strings.Contains(exitedStates, fields[index]) {
		return processIdentity{kind: processKindExited}
	}
	index := statStartTimeField - firstStatFieldAfterName
	if index >= len(fields) {
		return processIdentity{}
	}
	startTicks, err := strconv.ParseFloat(fields[index], 64)
	if err != nil {
		return processIdentity{}
	}
	uptimeText, err := os.ReadFile(procUptimePath)
	if err != nil {
		return processIdentity{}
	}
	uptimeFields := strings.Fields(string(uptimeText))
	if len(uptimeFields) == 0 {
		return processIdentity{}
	}
	uptime, err := strconv.ParseFloat(uptimeFields[0], 64)
	ticks := clockTicksPerSecond()
	if err != nil || ticks == 0 || math.IsInf(startTicks, 0) || math.IsNaN(uptime) {
		return processIdentity{}
	}
	now := float64(time.Now().UnixMilli())
	started := now - (uptime-startTicks/ticks)*millisecondsPerSecond
	return processIdentity{kind: processKindProcess, startMs: int64(math.Round(started))}
}

func selfStartMs() (int64, bool) {
	found := identifyProcess(os.Getpid())
	return found.startMs, found.kind == processKindProcess
}

func holdsFileInDirectoryOf(pid int, lockPath string) bool {
	descriptorDirectory := procDirectory + strconv.Itoa(pid) + "/fd"
	entries, err := os.ReadDir(descriptorDirectory)
	if err != nil {
		return false
	}
	directory, err := filepath.EvalSymlinks(filepath.Dir(lockPath))
	if err != nil {
		return false
	}
	inside := strings.TrimSuffix(directory, "/") + "/"
	for _, entry := range entries {
		target, err := os.Readlink(descriptorDirectory + "/" + entry.Name())
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return false
		}
		if target == directory || strings.HasPrefix(target, inside) {
			return true
		}
	}
	return false
}

func holderIsLive(holder lockHolder, self lockHolder, lockPath string) bool {
	tolerance := lockProcessStartTolerance.Milliseconds()
	if holder.pid == self.pid {
		if !holder.hasStart || !self.hasStart {
			return false
		}
		if abs64(holder.startMs-self.startMs) <= tolerance {
			return true
		}
		return holdsFileInDirectoryOf(holder.pid, lockPath)
	}
	if !signalReaches(holder.pid) {
		return false
	}
	found := identifyProcess(holder.pid)
	switch found.kind {
	case processKindThread, processKindExited:
		return false
	case processKindUnknown:
		return signalReaches(holder.pid)
	}
	if !holder.hasStart {
		return true
	}
	if found.startMs-holder.startMs <= tolerance {
		return true
	}
	return holdsFileInDirectoryOf(holder.pid, lockPath)
}

func abs64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}
