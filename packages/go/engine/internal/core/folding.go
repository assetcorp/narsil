package core

/*
#include "native/include/narsil_folding.h"
*/
import "C"

import (
	"errors"
	"runtime"
	"sync"
	"unsafe"
)

const maxFoldTableAttempts = 4

func LanguageFolds(language uint32) bool {
	var folds C.uint32_t
	return C.narsil_language_folds(C.uint32_t(language), &folds) == C.NARSIL_OK && folds != 0
}

func (a *Analyser) FoldSpelling(language uint32, spelling string, stem bool) (string, error) {
	length, err := a.loadText(spelling)
	if err != nil {
		return "", err
	}
	flags := C.uint32_t(0)
	if stem {
		flags = C.NARSIL_FOLD_STEM
	}
	var term C.narsil_term
	status := C.narsil_fold_spelling(a.resources.analyser, C.uint32_t(language), a.resources.text, length, flags, &term)
	if err := statusError("foldSpelling", status); err != nil {
		return "", err
	}
	if term.length == 0 || term.units == nil {
		return "", nil
	}
	return unitsToString(unsafe.Slice((*uint16)(unsafe.Pointer(term.units)), int(term.length))), nil
}

type foldTableHandle struct {
	table *C.narsil_fold_table
}

type FoldTable struct {
	mu     sync.RWMutex
	handle *foldTableHandle
}

func destroyFoldTable(handle *foldTableHandle) {
	if handle.table != nil {
		C.narsil_fold_table_destroy(handle.table)
	}
}

func NewFoldTable() *FoldTable {
	handle := &foldTableHandle{}
	table := &FoldTable{handle: handle}
	runtime.AddCleanup(table, destroyFoldTable, handle)
	return table
}

func (t *FoldTable) current(segment *C.narsil_expansion_segment, language uint32) bool {
	return t.handle.table != nil && C.narsil_fold_table_current(t.handle.table, segment, C.uint32_t(language)) != 0
}

func (t *FoldTable) update(workspace *Workspace, segment *C.narsil_expansion_segment, language uint32) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.current(segment, language) {
		return nil
	}
	if t.handle.table == nil {
		var created *C.narsil_fold_table
		if err := statusError("foldTableCreate", C.narsil_fold_table_create(&created)); err != nil {
			return err
		}
		t.handle.table = created
	}
	analyser, err := AcquireAnalyser()
	if err != nil {
		return err
	}
	defer analyser.Release()
	status := C.narsil_fold_table_update(workspace.pointer(), analyser.resources.analyser, t.handle.table, segment,
		C.uint32_t(language))
	runtime.KeepAlive(workspace)
	runtime.KeepAlive(analyser)
	return statusError("foldTableUpdate", status)
}

type heldFoldTables struct {
	tables   []*FoldTable
	pointers []*C.narsil_fold_table
}

func (h *heldFoldTables) release() {
	for _, table := range h.tables {
		table.mu.RUnlock()
	}
	h.tables = nil
}

var ErrFoldTablesChanged = errors.New("the fold tables of a partition kept changing while a search read them")

func holdFoldTables(workspace *Workspace, tables []*FoldTable, segments []C.narsil_expansion_segment,
	language uint32) (*heldFoldTables, error) {
	if len(tables) != len(segments) {
		return nil, &StatusError{Operation: "foldTables", Status: StatusInvalidArgument}
	}
	for range maxFoldTableAttempts {
		for at, table := range tables {
			if table == nil {
				return nil, &StatusError{Operation: "foldTables", Status: StatusInvalidArgument}
			}
			if err := table.update(workspace, &segments[at], language); err != nil {
				return nil, err
			}
		}
		held := &heldFoldTables{pointers: make([]*C.narsil_fold_table, len(tables))}
		current := true
		for at, table := range tables {
			table.mu.RLock()
			held.tables = append(held.tables, table)
			if !table.current(&segments[at], language) {
				current = false
				break
			}
			held.pointers[at] = table.handle.table
		}
		if current {
			return held, nil
		}
		held.release()
	}
	return nil, ErrFoldTablesChanged
}
