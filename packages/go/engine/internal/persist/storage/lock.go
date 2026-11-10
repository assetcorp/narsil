package storage

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type lockHolder struct {
	pid      int
	thread   string
	startMs  int64
	hasStart bool
	token    string
}

type DirectoryLock struct {
	root     string
	lockPath string
	key      string
	token    string
	held     *os.File
	mutex    sync.Mutex
	released bool
}

var (
	lockedMutex       sync.Mutex
	lockedDirectories = map[string]struct{}{}
)

func parseHolder(text string) (lockHolder, bool) {
	lines := strings.Split(text, "\n")
	for len(lines) < 4 {
		lines = append(lines, "")
	}
	pid, err := strconv.Atoi(lines[0])
	if err != nil || pid <= 0 {
		return lockHolder{}, false
	}
	holder := lockHolder{pid: pid, thread: lines[1], token: strings.TrimSpace(lines[3])}
	if start, err := strconv.ParseInt(lines[2], 10, 64); err == nil {
		holder.startMs = start
		holder.hasStart = true
	}
	return holder, true
}

func (holder lockHolder) format() string {
	start := ""
	if holder.hasStart {
		start = strconv.FormatInt(holder.startMs, 10)
	}
	return strconv.Itoa(holder.pid) + "\n" + holder.thread + "\n" + start + "\n" + holder.token + "\n"
}

type lockReading struct {
	holder  lockHolder
	present bool
	valid   bool
}

func readHolder(lockPath string) (lockReading, error) {
	text, err := readWhole(lockPath)
	if err != nil {
		if isMissing(err) {
			return lockReading{}, nil
		}
		return lockReading{}, err
	}
	holder, valid := parseHolder(string(text))
	return lockReading{holder: holder, present: true, valid: valid}, nil
}

func settledHolder(lockPath string) (lockReading, error) {
	first, err := readHolder(lockPath)
	if err != nil || !first.present || first.valid {
		return first, err
	}
	time.Sleep(lockSettleDelay)
	return readHolder(lockPath)
}

func (reading lockReading) same(text string) bool {
	holder, valid := parseHolder(text)
	if !reading.valid || !valid {
		return reading.valid == valid
	}
	return reading.holder.format() == holder.format()
}

func heldElsewhere(root string, holder string, lockPath string) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid,
		`The durability directory "`+root+`" is in use by `+holder+
			", and only one engine may write a write-ahead log directory. Point this engine at another directory, "+
			`or shut the other engine down first. Where no engine uses the directory, delete "`+lockPath+`"`,
		map[string]any{"directory": root})
}

func hardLinkUnsupported(err error) bool {
	return errors.Is(err, fs.ErrPermission) || errors.Is(err, errors.ErrUnsupported)
}

func createExclusively(lockPath string, content string) (bool, error) {
	file, err := openFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fileMode)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return false, nil
		}
		return false, err
	}
	_, err = file.WriteString(content)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return err == nil, err
}

func createLockFile(lockPath string, draftPath string, content string) (bool, error) {
	if err := os.WriteFile(draftPath, []byte(content), fileMode); err != nil {
		return false, err
	}
	defer os.Remove(draftPath)
	err := os.Link(draftPath, lockPath)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	if hardLinkUnsupported(err) {
		return createExclusively(lockPath, content)
	}
	return false, err
}

func removeStaleLock(lockPath string, asidePath string, reading lockReading) error {
	if err := os.Rename(lockPath, asidePath); err != nil {
		if isMissing(err) {
			return nil
		}
		return err
	}
	defer os.Remove(asidePath)
	moved, err := readWhole(asidePath)
	if err != nil {
		return err
	}
	if !reading.same(string(moved)) {
		if _, err := createExclusively(lockPath, string(moved)); err != nil {
			return err
		}
	}
	return nil
}

func holderLabel(holder lockHolder, self lockHolder) string {
	if holder.pid != self.pid {
		return "process " + strconv.Itoa(holder.pid)
	}
	if holder.thread == self.thread {
		return "another copy of Narsil in this thread"
	}
	return "another thread of this process"
}

func acquire(root string, lockPath string, self lockHolder) error {
	draftPath := lockPath + "." + strconv.Itoa(self.pid) + "." + self.thread
	content := self.format()
	for range lockAttempts {
		created, err := createLockFile(lockPath, draftPath, content)
		if err != nil {
			return err
		}
		if created {
			return nil
		}
		reading, err := settledHolder(lockPath)
		if err != nil {
			return err
		}
		if reading.present && reading.valid && holderIsLive(reading.holder, self, lockPath) {
			return heldElsewhere(root, holderLabel(reading.holder, self), lockPath)
		}
		if err := removeStaleLock(lockPath, draftPath+".aside", reading); err != nil {
			return err
		}
	}
	return heldElsewhere(root, "another process", lockPath)
}

func describeSelf() lockHolder {
	token := make([]byte, lockTokenBytes)
	_, _ = rand.Read(token)
	holder := lockHolder{pid: os.Getpid(), thread: "0", token: hex.EncodeToString(token)}
	holder.startMs, holder.hasStart = selfStartMs()
	return holder
}

func (directory *Directory) Lock() (*DirectoryLock, error) {
	root := directory.root
	lockPath := filepath.Join(root, LockFileName)
	self := describeSelf()
	lock := &DirectoryLock{root: root, lockPath: lockPath, token: self.token}
	key, err := identityAt(root)
	if err != nil {
		return nil, saveFailed(`The engine cannot lock the durability directory "`+root+`"`, root, err)
	}
	lockedMutex.Lock()
	if _, taken := lockedDirectories[key]; taken {
		lockedMutex.Unlock()
		return nil, heldElsewhere(root, "another engine in this process", lockPath)
	}
	lockedDirectories[key] = struct{}{}
	lockedMutex.Unlock()
	lock.key = key
	if err := acquire(root, lockPath, self); err != nil {
		lock.forget()
		lock.removeOwnFile()
		return nil, keepNarsilError(err, func(cause error) error {
			return saveFailed(`The engine cannot lock the durability directory "`+root+`"`, root, cause)
		})
	}
	if runtime.GOOS != directoryHeldOpenOnlyOn {
		return lock, nil
	}
	if held, err := os.Open(root); err == nil {
		lock.held = held
	}
	return lock, nil
}

func (lock *DirectoryLock) forget() {
	lockedMutex.Lock()
	delete(lockedDirectories, lock.key)
	lockedMutex.Unlock()
}

func (lock *DirectoryLock) Holds() bool {
	reading, err := readHolder(lock.lockPath)
	return err == nil && reading.present && reading.valid && reading.holder.token == lock.token
}

func (lock *DirectoryLock) removeOwnFile() {
	if lock.Holds() {
		_ = os.Remove(lock.lockPath)
	}
}

func (lock *DirectoryLock) Release() {
	lock.mutex.Lock()
	defer lock.mutex.Unlock()
	if lock.released {
		return
	}
	lock.released = true
	lock.forget()
	lock.removeOwnFile()
	if lock.held != nil {
		_ = lock.held.Close()
	}
}
