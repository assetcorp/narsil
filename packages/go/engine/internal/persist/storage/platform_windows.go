//go:build windows

package storage

import (
	"errors"
	"io"
	"io/fs"
	"math"
	"os"
	"strconv"
	"syscall"
)

const (
	processQueryLimitedInformation = 0x00001000
	stillActiveExitCode            = 259
	errorInvalidFunction           = syscall.Errno(1)
	errorInvalidHandle             = syscall.Errno(6)
	errorNotSupported              = syscall.Errno(50)
	errorInvalidParameter          = syscall.Errno(87)
	everySharingMode               = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE | syscall.FILE_SHARE_DELETE
)

func identityAt(path string) (string, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", &os.PathError{Op: "stat", Path: path, Err: err}
	}
	handle, err := syscall.CreateFile(name, 0, everySharingMode, nil, syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", &os.PathError{Op: "stat", Path: path, Err: err}
	}
	defer syscall.CloseHandle(handle)
	var information syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &information); err != nil {
		return "", &os.PathError{Op: "stat", Path: path, Err: err}
	}
	index := uint64(information.FileIndexHigh)<<32 | uint64(information.FileIndexLow)
	return strconv.FormatUint(uint64(information.VolumeSerialNumber), 10) + ":" +
		strconv.FormatUint(index, 10), nil
}

func signalReaches(pid int) bool {
	if pid <= 0 || pid > math.MaxUint32 {
		return false
	}
	handle, err := syscall.OpenProcess(processQueryLimitedInformation|syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return !errors.Is(err, errorInvalidParameter)
	}
	defer syscall.CloseHandle(handle)
	var exitCode uint32
	if err := syscall.GetExitCodeProcess(handle, &exitCode); err != nil {
		return true
	}
	if exitCode != stillActiveExitCode {
		return false
	}
	event, err := syscall.WaitForSingleObject(handle, 0)
	return err != nil || event != syscall.WAIT_OBJECT_0
}

func accessOf(flag int) uint32 {
	switch flag & (os.O_RDONLY | os.O_WRONLY | os.O_RDWR) {
	case os.O_WRONLY:
		return syscall.GENERIC_WRITE
	case os.O_RDWR:
		return syscall.GENERIC_READ | syscall.GENERIC_WRITE
	}
	if flag&os.O_CREATE != 0 {
		return syscall.GENERIC_READ | syscall.GENERIC_WRITE
	}
	return syscall.GENERIC_READ
}

func creationOf(flag int) uint32 {
	switch {
	case flag&(os.O_CREATE|os.O_EXCL) == os.O_CREATE|os.O_EXCL:
		return syscall.CREATE_NEW
	case flag&os.O_CREATE != 0:
		return syscall.OPEN_ALWAYS
	}
	return syscall.OPEN_EXISTING
}

func openFile(path string, flag int, perm os.FileMode) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	attributes := uint32(syscall.FILE_ATTRIBUTE_NORMAL)
	if perm&syscall.S_IWRITE == 0 {
		attributes = syscall.FILE_ATTRIBUTE_READONLY
	}
	if flag&(os.O_WRONLY|os.O_RDWR) == 0 {
		attributes |= syscall.FILE_FLAG_BACKUP_SEMANTICS
	}
	creation := creationOf(flag)
	if creation == syscall.CREATE_NEW {
		attributes |= syscall.FILE_FLAG_OPEN_REPARSE_POINT
	}
	handle, err := syscall.CreateFile(name, accessOf(flag), everySharingMode, nil, creation, attributes, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	if flag&os.O_TRUNC != 0 {
		if err := syscall.Ftruncate(handle, 0); err != nil {
			_ = syscall.CloseHandle(handle)
			return nil, &os.PathError{Op: "truncate", Path: path, Err: err}
		}
	}
	file := os.NewFile(uintptr(handle), path)
	if flag&os.O_APPEND != 0 {
		if _, err := file.Seek(0, io.SeekEnd); err != nil {
			_ = file.Close()
			return nil, &os.PathError{Op: "seek", Path: path, Err: err}
		}
	}
	return file, nil
}

func directorySyncUnsupportedHere(err error) bool {
	return errors.Is(err, fs.ErrPermission) || errors.Is(err, errorInvalidFunction) ||
		errors.Is(err, errorInvalidHandle) || errors.Is(err, errorNotSupported) ||
		errors.Is(err, errorInvalidParameter)
}
