//go:build unix

package storage

import (
	"errors"
	"os"
	"strconv"
	"syscall"
)

func identityAt(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return info.Name(), nil
	}
	return strconv.FormatUint(uint64(stat.Dev), 10) + ":" + strconv.FormatUint(stat.Ino, 10), nil
}

func signalReaches(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func openFile(path string, flag int, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flag, perm)
}

func directorySyncUnsupportedHere(error) bool {
	return false
}
