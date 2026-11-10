package core

/*
#include "native/include/narsil_core.h"
*/
import "C"

import (
	"runtime"
	"sync"
	"unsafe"
)

type Workspace struct {
	resources *workspaceResources
}

type workspaceResources struct {
	workspace *C.narsil_workspace
}

var workspacePool = sync.Pool{New: newWorkspace}

func newWorkspace() any {
	var created *C.narsil_workspace
	if C.narsil_workspace_create(&created) != C.NARSIL_OK {
		return nil
	}
	resources := &workspaceResources{workspace: created}
	workspace := &Workspace{resources: resources}
	runtime.AddCleanup(workspace, releaseWorkspaceResources, resources)
	return workspace
}

func releaseWorkspaceResources(resources *workspaceResources) {
	C.narsil_workspace_destroy(resources.workspace)
}

func AcquireWorkspace() (*Workspace, error) {
	workspace, _ := workspacePool.Get().(*Workspace)
	if workspace == nil {
		return nil, &StatusError{Operation: "workspaceCreate", Status: StatusOutOfMemory}
	}
	return workspace, nil
}

func (w *Workspace) Release() {
	workspacePool.Put(w)
}

func (w *Workspace) Bytes() uint64 {
	bytes := uint64(C.narsil_workspace_bytes(w.resources.workspace))
	runtime.KeepAlive(w)
	return bytes
}

func (w *Workspace) pointer() *C.narsil_workspace {
	return w.resources.workspace
}

type pins struct {
	pinner runtime.Pinner
}

func pinned[T any](held *pins, values []T) *T {
	if len(values) == 0 {
		return nil
	}
	first := unsafe.SliceData(values)
	held.pinner.Pin(first)
	return first
}

func (p *pins) release() {
	p.pinner.Unpin()
}
