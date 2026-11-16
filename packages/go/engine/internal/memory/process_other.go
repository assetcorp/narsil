//go:build !linux && !windows && !(darwin && cgo)

package memory

func platformProcessBytes() (uint64, bool) {
	return 0, false
}

func platformLimitBytes(uint64) (uint64, bool) {
	return 0, false
}
