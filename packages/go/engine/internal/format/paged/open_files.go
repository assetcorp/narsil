package paged

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"weak"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type openNativeFiles struct {
	mu    sync.Mutex
	files map[weak.Pointer[NativeFile]]struct{}
}

var openFiles = &openNativeFiles{files: map[weak.Pointer[NativeFile]]struct{}{}}

func (open *openNativeFiles) add(file *NativeFile) {
	held := weak.Make(file)
	open.mu.Lock()
	open.files[held] = struct{}{}
	open.mu.Unlock()
	runtime.AddCleanup(file, open.remove, held)
}

func (open *openNativeFiles) remove(held weak.Pointer[NativeFile]) {
	open.mu.Lock()
	delete(open.files, held)
	open.mu.Unlock()
}

func (open *openNativeFiles) held() []*NativeFile {
	open.mu.Lock()
	defer open.mu.Unlock()
	files := make([]*NativeFile, 0, len(open.files))
	for held := range open.files {
		if file := held.Value(); file != nil {
			files = append(files, file)
		}
	}
	return files
}

func (file *NativeFile) under(folder string) bool {
	file.mu.RLock()
	path := file.path
	file.mu.RUnlock()
	rest, under := strings.CutPrefix(path, folder)
	return under && rest != "" && rest[0] == filepath.Separator
}

func (file *NativeFile) suspendIfOpen() (bool, error) {
	file.mu.Lock()
	defer file.mu.Unlock()
	if file.file == nil {
		return false, nil
	}
	if err := file.native.Suspend(); err != nil {
		if errors.Is(err, core.ErrPagedFileClosed) {
			return false, nil
		}
		return false, err
	}
	err := file.file.Close()
	file.file = nil
	return true, err
}

func (file *NativeFile) reopen(open func(path string) (*os.File, error)) error {
	file.mu.RLock()
	path := file.path
	file.mu.RUnlock()
	opened, err := open(path)
	if err != nil {
		return cannotOpen(path, err)
	}
	return file.Resume(opened, path)
}

type Suspension struct {
	open  func(path string) (*os.File, error)
	files []*NativeFile
}

func SuspendUnder(folder string, open func(path string) (*os.File, error)) (*Suspension, error) {
	suspension := &Suspension{open: open}
	for _, file := range openFiles.held() {
		if !file.under(folder) {
			continue
		}
		suspended, err := file.suspendIfOpen()
		if suspended {
			suspension.files = append(suspension.files, file)
		}
		if err != nil {
			return nil, errors.Join(err, suspension.Resume())
		}
	}
	return suspension, nil
}

func (suspension *Suspension) Resume() error {
	var failures []error
	for _, file := range suspension.files {
		if err := file.reopen(suspension.open); err != nil {
			failures = append(failures, err)
		}
	}
	suspension.files = nil
	return errors.Join(failures...)
}
