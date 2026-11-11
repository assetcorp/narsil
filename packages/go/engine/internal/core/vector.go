package core

/*
#include "native/include/narsil_core.h"
*/
import "C"

import (
	"runtime"
)

type SearchRequest struct {
	Query          []float32
	Metric         Metric
	CandidateCount uint32
	ThreadSlot     uint32
	Pin            int64
	Accepted       []byte
	HasAccepted    bool
}

var noAcceptedOrdinal = []byte{0}

func (w *Workspace) Search(graph *Graph, store *Store, request SearchRequest, ordinals []int32, distances []float64) (int, error) {
	if uint32(len(request.Query)) != store.Dimension() {
		return 0, &StatusError{Operation: "search", Status: StatusInvalidArgument}
	}
	capacity := min(len(ordinals), len(distances))
	if uint32(capacity) < request.CandidateCount {
		return 0, &StatusError{Operation: "search", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := C.narsil_search_request{
		query:           (*C.float)(pinned(&held, request.Query)),
		metric:          C.uint32_t(request.Metric),
		candidate_count: C.uint32_t(request.CandidateCount),
		thread_slot:     C.uint32_t(request.ThreadSlot),
		pin:             C.int64_t(request.Pin),
	}
	if request.HasAccepted {
		accepted := request.Accepted
		if len(accepted) == 0 {
			accepted = noAcceptedOrdinal
			native.accepted.bytes = 0
		} else {
			native.accepted.bytes = uint32Length(len(accepted))
		}
		native.accepted.bits = (*C.uint8_t)(pinned(&held, accepted))
	}
	nearest := C.narsil_candidates{
		ordinals:  (*C.int32_t)(pinned(&held, ordinals)),
		distances: (*C.double)(pinned(&held, distances)),
		capacity:  uint32Length(capacity),
	}
	status := C.narsil_search(w.pointer(), graph.graph, store.store, &native, &nearest)
	runtime.KeepAlive(w)
	if err := statusError("search", status); err != nil {
		return 0, err
	}
	return int(nearest.count), nil
}

func (w *Workspace) Score(store *Store, query []float32, metric Metric, pin int64, ordinals []int32, distances []float64) error {
	if uint32(len(query)) != store.Dimension() || len(distances) < len(ordinals) {
		return &StatusError{Operation: "score", Status: StatusInvalidArgument}
	}
	if len(ordinals) == 0 {
		return nil
	}
	var held pins
	defer held.release()
	native := C.narsil_score_request{
		query:    (*C.float)(pinned(&held, query)),
		metric:   C.uint32_t(metric),
		ordinals: (*C.int32_t)(pinned(&held, ordinals)),
		count:    uint32Length(len(ordinals)),
		pin:      C.int64_t(pin),
	}
	status := C.narsil_score(w.pointer(), store.store, &native, (*C.double)(pinned(&held, distances)))
	runtime.KeepAlive(w)
	return statusError("score", status)
}

type PlaceRequest struct {
	Metric         Metric
	Ordinal        int32
	TopLayer       int32
	ThreadSlot     uint32
	GraphHeldAlone bool
}

func (w *Workspace) Place(graph *Graph, store *Store, request PlaceRequest) error {
	native := C.narsil_place_request{
		metric:      C.uint32_t(request.Metric),
		ordinal:     C.int32_t(request.Ordinal),
		top_layer:   C.int32_t(request.TopLayer),
		thread_slot: C.uint32_t(request.ThreadSlot),
	}
	if request.GraphHeldAlone {
		native.graph_held_alone = 1
	}
	status := C.narsil_place(w.pointer(), graph.graph, store.store, &native)
	runtime.KeepAlive(w)
	return statusError("place", status)
}

func RemoveNode(graph *Graph, ordinal int32, threadSlot uint32) error {
	native := C.narsil_remove_request{ordinal: C.int32_t(ordinal), thread_slot: C.uint32_t(threadSlot)}
	return statusError("remove", C.narsil_remove(graph.graph, &native))
}

func (w *Workspace) Compact(graph *Graph, store *Store, metric Metric, threadSlot uint32) error {
	native := C.narsil_compact_request{metric: C.uint32_t(metric), thread_slot: C.uint32_t(threadSlot)}
	status := C.narsil_compact(w.pointer(), graph.graph, store.store, &native)
	runtime.KeepAlive(w)
	return statusError("compact", status)
}

func (w *Workspace) ConnectUnreached(graph *Graph, store *Store, metric Metric, threadSlot uint32, nearby []int32) error {
	var held pins
	defer held.release()
	native := C.narsil_connect_request{
		metric:       C.uint32_t(metric),
		thread_slot:  C.uint32_t(threadSlot),
		nearby:       (*C.int32_t)(pinned(&held, nearby)),
		nearby_count: uint32Length(len(nearby)),
	}
	status := C.narsil_connect_unreached(w.pointer(), graph.graph, store.store, &native)
	runtime.KeepAlive(w)
	return statusError("connectUnreached", status)
}

func (w *Workspace) Quantise(store *Store, metric Metric, ordinals []int32) error {
	if len(ordinals) == 0 {
		return nil
	}
	var held pins
	defer held.release()
	native := C.narsil_ordinals_request{
		metric:   C.uint32_t(metric),
		ordinals: (*C.int32_t)(pinned(&held, ordinals)),
		count:    uint32Length(len(ordinals)),
	}
	status := C.narsil_quantise(w.pointer(), store.store, &native)
	runtime.KeepAlive(w)
	return statusError("quantise", status)
}

func (w *Workspace) Measure(store *Store, metric Metric, ordinals []int32, totals []float64) error {
	if uint32(len(totals)) < store.Dimension()+2 {
		return &StatusError{Operation: "measure", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := C.narsil_ordinals_request{
		metric:   C.uint32_t(metric),
		ordinals: (*C.int32_t)(pinned(&held, ordinals)),
		count:    uint32Length(len(ordinals)),
	}
	status := C.narsil_measure(w.pointer(), store.store, &native, (*C.double)(pinned(&held, totals)))
	runtime.KeepAlive(w)
	return statusError("measure", status)
}
