package core

/*
#include "native/include/narsil_paged_vectors.h"
*/
import "C"

import "runtime"

type PagedVectorFile struct {
	First   uint32
	Count   uint32
	Dead    []byte
	Vectors PageSection
	Records *PageSection
}

type PagedGraphPart struct {
	First       uint32
	Count       uint32
	Levels      []byte
	NodeOffsets []uint32
	Neighbours  PageSection
}

type PagedVectorCodes struct {
	Bits     uint32
	Centroid []float32
}

type PagedVectorField struct {
	Dimension     uint32
	Metric        Metric
	Total         uint32
	EntryPoint    uint32
	HasEntryPoint bool
	MaxLayer      uint32
	Codes         *PagedVectorCodes
	Files         []PagedVectorFile
	GraphParts    []PagedGraphPart
}

type PagedVectorRequest struct {
	Query                 []float32
	K                     uint32
	Ef                    uint32
	RescoreDepth          uint32
	ExplicitRescoreWindow bool
	MinSimilarity         float64
	Accepted              []uint32
	HasAccepted           bool
	Excluded              []uint32
	HasExcluded           bool
	Meter                 *WorkMeter
}

type PagedVectorOutput struct {
	Ordinals []uint32
	Scores   []float64
}

func (call *pagedCall) vectorFiles(sources []PagedVectorFile) ([]C.narsil_paged_vector_file, error) {
	files := make([]C.narsil_paged_vector_file, len(sources))
	records := make([]C.narsil_page_section, len(sources))
	for at := range sources {
		source := &sources[at]
		vectors, err := call.files.section(&call.held, &source.Vectors)
		if err != nil {
			return nil, err
		}
		files[at] = C.narsil_paged_vector_file{
			first:      C.uint32_t(source.First),
			count:      C.uint32_t(source.Count),
			dead:       (*C.uint8_t)(pinned(&call.held, source.Dead)),
			dead_bytes: C.size_t(len(source.Dead)),
			vectors:    vectors,
		}
		if source.Records == nil {
			continue
		}
		if records[at], err = call.files.section(&call.held, source.Records); err != nil {
			return nil, err
		}
		files[at].records = &records[at]
	}
	pinned(&call.held, records)
	return files, nil
}

func (call *pagedCall) graphParts(sources []PagedGraphPart) ([]C.narsil_paged_graph_part, error) {
	parts := make([]C.narsil_paged_graph_part, len(sources))
	for at := range sources {
		source := &sources[at]
		neighbours, err := call.files.section(&call.held, &source.Neighbours)
		if err != nil {
			return nil, err
		}
		parts[at] = C.narsil_paged_graph_part{
			first:        C.uint32_t(source.First),
			count:        C.uint32_t(source.Count),
			levels:       (*C.uint8_t)(pinned(&call.held, source.Levels)),
			level_count:  C.size_t(len(source.Levels)),
			node_offsets: (*C.uint32_t)(pinned(&call.held, source.NodeOffsets)),
			offset_count: C.size_t(len(source.NodeOffsets)),
			neighbours:   neighbours,
		}
	}
	return parts, nil
}

func (call *pagedCall) vectorField(field *PagedVectorField) (C.narsil_paged_vector_field, error) {
	files, err := call.vectorFiles(field.Files)
	if err != nil {
		return C.narsil_paged_vector_field{}, err
	}
	parts, err := call.graphParts(field.GraphParts)
	if err != nil {
		return C.narsil_paged_vector_field{}, err
	}
	native := C.narsil_paged_vector_field{
		dimension:   C.uint32_t(field.Dimension),
		metric:      C.uint32_t(field.Metric),
		total:       C.uint32_t(field.Total),
		entry_point: C.uint32_t(field.EntryPoint),
		max_layer:   C.uint32_t(field.MaxLayer),
		files:       pinned(&call.held, files),
		file_count:  C.size_t(len(files)),
		parts:       pinned(&call.held, parts),
		part_count:  C.size_t(len(parts)),
	}
	if field.HasEntryPoint {
		native.has_entry_point = 1
	}
	if field.Codes != nil {
		native.bits = C.uint32_t(field.Codes.Bits)
		native.centroid = (*C.float)(pinned(&call.held, field.Codes.Centroid))
		native.centroid_count = C.size_t(len(field.Codes.Centroid))
	}
	return native, nil
}

func pagedVectorRequestValid(field *PagedVectorField, request *PagedVectorRequest) bool {
	return field != nil && request != nil && request.Meter != nil && request.Meter.words != nil &&
		(field.Codes == nil || field.Codes.Bits != 0) && (!request.HasAccepted || len(request.Accepted) > 0) &&
		(!request.HasExcluded || len(request.Excluded) > 0)
}

func (w *Workspace) SearchPagedVectors(cache *PageCache, field *PagedVectorField, request *PagedVectorRequest,
	output PagedVectorOutput) (int, error) {
	if !pagedVectorRequestValid(field, request) {
		return 0, &StatusError{Operation: "searchPagedVectors", Status: StatusInvalidArgument}
	}
	var call pagedCall
	defer call.close()
	if err := call.begin(cache); err != nil {
		return 0, err
	}
	native, err := call.vectorField(field)
	if err != nil {
		return 0, err
	}
	query := C.narsil_paged_vector_request{
		query:          (*C.float)(pinned(&call.held, request.Query)),
		query_count:    C.size_t(len(request.Query)),
		k:              C.uint32_t(request.K),
		ef:             C.uint32_t(request.Ef),
		rescore_depth:  C.uint32_t(request.RescoreDepth),
		min_similarity: C.double(request.MinSimilarity),
		meter:          request.Meter.native(),
	}
	if request.ExplicitRescoreWindow {
		query.explicit_rescore_window = 1
	}
	if request.HasAccepted {
		query.accepted = (*C.uint32_t)(pinned(&call.held, request.Accepted))
		query.accepted_words = C.size_t(len(request.Accepted))
	}
	if request.HasExcluded {
		query.excluded = (*C.uint32_t)(pinned(&call.held, request.Excluded))
		query.excluded_words = C.size_t(len(request.Excluded))
	}
	out := C.narsil_paged_vector_output{
		ordinals:         (*C.uint32_t)(pinned(&call.held, output.Ordinals)),
		ordinal_capacity: C.size_t(len(output.Ordinals)),
		scores:           (*C.double)(pinned(&call.held, output.Scores)),
		score_capacity:   C.size_t(len(output.Scores)),
	}
	status := C.narsil_search_paged_vectors(w.pointer(), call.cache, &native, &query, &out, &call.results.count,
		&call.results.fault)
	runtime.KeepAlive(w)
	runtime.KeepAlive(request.Meter)
	if err := pagedStatusError("searchPagedVectors", status, &call.results.fault); err != nil {
		return 0, err
	}
	return int(call.results.count), nil
}
