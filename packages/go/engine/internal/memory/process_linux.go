package memory

import (
	"bytes"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	processStatusPath      = "/proc/self/status"
	processStatmPath       = "/proc/self/statm"
	processCgroupPath      = "/proc/self/cgroup"
	memoryInfoPath         = "/proc/meminfo"
	cgroupRoot             = "/sys/fs/cgroup"
	cgroupV1MemoryRoot     = "/sys/fs/cgroup/memory"
	cgroupV1LimitFile      = "memory.limit_in_bytes"
	anonymousResidentField = "RssAnon:"
	sharedResidentField    = "RssShmem:"
	residentSetField       = "VmRSS:"
	totalMemoryField       = "MemTotal:"
	availableMemoryField   = "MemAvailable:"
)

var cgroupV2LimitFiles = []string{"memory.max", "memory.high"}

func readSmallFile(path string) ([]byte, bool) {
	file, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, processStatusReadCeilingBytes+1))
	if err != nil || len(content) > processStatusReadCeilingBytes {
		return nil, false
	}
	return content, true
}

func kibibyteField(content []byte, field string) (uint64, bool) {
	for line := range bytes.Lines(content) {
		rest, found := bytes.CutPrefix(line, []byte(field))
		if !found {
			continue
		}
		digits, unit := bytes.CutSuffix(bytes.TrimSpace(rest), []byte("kB"))
		if !unit {
			return 0, false
		}
		kibibytes, err := strconv.ParseUint(string(bytes.TrimSpace(digits)), 10, 64)
		if err != nil || kibibytes > math.MaxUint64/kibibyteBytes {
			return 0, false
		}
		return kibibytes * kibibyteBytes, true
	}
	return 0, false
}

func statusProcessBytes() (uint64, bool) {
	status, read := readSmallFile(processStatusPath)
	if !read {
		return 0, false
	}
	anonymous, anonymousFound := kibibyteField(status, anonymousResidentField)
	shared, sharedFound := kibibyteField(status, sharedResidentField)
	if anonymousFound && sharedFound && anonymous <= math.MaxUint64-shared {
		return anonymous + shared, true
	}
	return kibibyteField(status, residentSetField)
}

func platformProcessBytes() (uint64, bool) {
	if processBytes, found := statusProcessBytes(); found {
		return processBytes, true
	}
	statm, read := readSmallFile(processStatmPath)
	if !read {
		return 0, false
	}
	fields := strings.Fields(string(statm))
	if len(fields) < 2 {
		return 0, false
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	pageBytes := uint64(os.Getpagesize())
	if err != nil || pageBytes == 0 || pages > math.MaxUint64/pageBytes {
		return 0, false
	}
	return pages * pageBytes, true
}

func limitIn(path string) (uint64, bool) {
	content, read := readSmallFile(path)
	if !read {
		return 0, false
	}
	limit, err := strconv.ParseUint(string(bytes.TrimSpace(content)), 10, 64)
	return limit, err == nil && limit > 0
}

func cgroupLimitBytes() (uint64, bool) {
	membership, read := readSmallFile(processCgroupPath)
	if !read {
		return 0, false
	}
	var smallest uint64
	found := false
	for line := range strings.Lines(string(membership)) {
		parts := strings.SplitN(strings.TrimRight(line, "\n"), ":", 3)
		if len(parts) != 3 {
			continue
		}
		root, files := cgroupRoot, cgroupV2LimitFiles
		if parts[1] != "" {
			if !holdsMemoryController(parts[1]) {
				continue
			}
			root, files = cgroupV1MemoryRoot, []string{cgroupV1LimitFile}
		}
		directory := filepath.Join(root, filepath.Clean("/"+parts[2]))
		for {
			for _, file := range files {
				if limit, set := limitIn(filepath.Join(directory, file)); set && (!found || limit < smallest) {
					smallest, found = limit, true
				}
			}
			if directory == root || len(directory) <= len(root) {
				break
			}
			directory = filepath.Dir(directory)
		}
	}
	return smallest, found
}

func holdsMemoryController(controllers string) bool {
	for controller := range strings.SplitSeq(controllers, ",") {
		if controller == "memory" {
			return true
		}
	}
	return false
}

func platformLimitBytes(processBytes uint64) (uint64, bool) {
	info, read := readSmallFile(memoryInfoPath)
	if !read {
		return 0, false
	}
	host, found := kibibyteField(info, totalMemoryField)
	if !found || host == 0 {
		return 0, false
	}
	if constrained, set := cgroupLimitBytes(); set && constrained < host {
		return constrained, true
	}
	available, found := kibibyteField(info, availableMemoryField)
	if !found || available > math.MaxUint64-processBytes {
		return host, true
	}
	return min(host, processBytes+available), true
}
