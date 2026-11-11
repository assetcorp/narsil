package core

/*
#include "native/include/narsil_keyword.h"
*/
import "C"

import (
	"math"
	"runtime"
)

const (
	KeywordTermSlot          = C.NARSIL_KEYWORD_TERM_SLOT
	KeywordGroupSlot         = C.NARSIL_KEYWORD_GROUP_SLOT
	KeywordPhraseSlot        = C.NARSIL_KEYWORD_PHRASE_SLOT
	KeywordSlotStride        = C.NARSIL_KEYWORD_SLOT_STRIDE
	KeywordSlotKind          = C.NARSIL_KEYWORD_SLOT_KIND
	KeywordSlotTerm          = C.NARSIL_KEYWORD_SLOT_TERM
	KeywordSlotListEnd       = C.NARSIL_KEYWORD_SLOT_LIST_END
	KeywordSlotValueEnd      = C.NARSIL_KEYWORD_SLOT_VALUE_END
	KeywordListStride        = C.NARSIL_KEYWORD_LIST_STRIDE
	KeywordListFlags         = C.NARSIL_KEYWORD_LIST_FLAGS
	KeywordListStart         = C.NARSIL_KEYWORD_LIST_START
	KeywordListLength        = C.NARSIL_KEYWORD_LIST_LENGTH
	KeywordListFromRows      = C.NARSIL_KEYWORD_LIST_FROM_ROWS
	KeywordListOrdered       = C.NARSIL_KEYWORD_LIST_ORDERED
	KeywordListValueStride   = C.NARSIL_KEYWORD_LIST_VALUE_STRIDE
	KeywordListDocFrequency  = C.NARSIL_KEYWORD_LIST_DOCUMENT_FREQUENCY
	KeywordListFactor        = C.NARSIL_KEYWORD_LIST_FACTOR
	KeywordListPartialFactor = C.NARSIL_KEYWORD_LIST_PARTIAL_FACTOR
	KeywordFieldBoosts       = C.NARSIL_KEYWORD_FIELD_BOOSTS
	KeywordFieldAverageLen   = C.NARSIL_KEYWORD_FIELD_AVERAGE_LENGTHS
	KeywordFieldK1           = C.NARSIL_KEYWORD_FIELD_K1
	KeywordFieldB            = C.NARSIL_KEYWORD_FIELD_B
	KeywordFieldNumberCols   = C.NARSIL_KEYWORD_FIELD_NUMBER_COLUMNS
	KeywordScoredInFull      = C.NARSIL_KEYWORD_SCORED_IN_FULL
	KeywordPruned            = C.NARSIL_KEYWORD_PRUNED
	KeywordPrunedThenFull    = C.NARSIL_KEYWORD_PRUNED_THEN_FULL
	KeywordMaxFields         = C.NARSIL_KEYWORD_MAX_FIELDS
)

const KeywordNoLimit = -1.0

type KeywordRequest struct {
	PoolDocIDs      []uint32
	PoolFrequencies []uint16
	PoolFields      []uint16
	RowDocIDs       []uint32
	RowFrequencies  []float64
	RowFields       []uint16
	Slots           []uint32
	SlotCount       uint32
	Lists           []uint32
	ListValues      []float64
	SlotValues      []float64
	Searchable      []uint8
	PartialMarks    []uint8
	NameRanks       []uint16
	FieldNumbers    []float64
	Lengths         [][]uint32
	HasFilter       bool
	Filter          []uint32
	Live            []uint32
	Removed         []uint32
	Terms           float64
	Capacity        uint32
	TotalDocuments  float64
	TermMatch       float64
	Limit           float64
	MinScore        float64
	Collect         bool
}

type KeywordOutput struct {
	Ordinals []int32
	Scores   []float64
	Matched  []uint32
}

type KeywordOutcome struct {
	Count        uint32
	TotalMatched uint32
	ScoringPath  uint32
}

func shortest(lengths ...int) int {
	least := math.MaxInt
	for _, length := range lengths {
		least = min(least, length)
	}
	return least
}

func uint32Length(length int) C.uint32_t {
	if length > math.MaxUint32 {
		return C.uint32_t(math.MaxUint32)
	}
	return C.uint32_t(length)
}

func (w *Workspace) KeywordScore(request *KeywordRequest, output *KeywordOutput) (KeywordOutcome, error) {
	fieldCount := len(request.Searchable)
	if fieldCount > KeywordMaxFields || len(request.PartialMarks) != fieldCount || len(request.NameRanks) != fieldCount ||
		len(request.FieldNumbers) != fieldCount*KeywordFieldNumberCols || len(request.Lengths) != fieldCount {
		return KeywordOutcome{}, &StatusError{Operation: "keywordScore", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	columns := make([]C.narsil_keyword_column, max(1, fieldCount))
	for field, lengths := range request.Lengths {
		columns[field].values = (*C.uint32_t)(pinned(&held, lengths))
		columns[field].length = uint32Length(len(lengths))
	}
	listRows := min(len(request.Lists)/KeywordListStride, len(request.ListValues)/KeywordListValueStride)
	native := C.narsil_keyword_request{
		pool_doc_ids:        (*C.uint32_t)(pinned(&held, request.PoolDocIDs)),
		pool_frequencies:    (*C.uint16_t)(pinned(&held, request.PoolFrequencies)),
		pool_fields:         (*C.uint16_t)(pinned(&held, request.PoolFields)),
		pool_length:         uint32Length(shortest(len(request.PoolDocIDs), len(request.PoolFrequencies), len(request.PoolFields))),
		row_doc_ids:         (*C.uint32_t)(pinned(&held, request.RowDocIDs)),
		row_frequencies:     (*C.double)(pinned(&held, request.RowFrequencies)),
		row_fields:          (*C.uint16_t)(pinned(&held, request.RowFields)),
		row_length:          uint32Length(shortest(len(request.RowDocIDs), len(request.RowFrequencies), len(request.RowFields))),
		slots:               (*C.uint32_t)(pinned(&held, request.Slots)),
		slot_count:          C.uint32_t(request.SlotCount),
		slot_capacity:       uint32Length(len(request.Slots) / KeywordSlotStride),
		lists:               (*C.uint32_t)(pinned(&held, request.Lists)),
		list_values:         (*C.double)(pinned(&held, request.ListValues)),
		list_capacity:       uint32Length(listRows),
		slot_values:         (*C.double)(pinned(&held, request.SlotValues)),
		slot_value_capacity: uint32Length(len(request.SlotValues)),
		field_count:         C.uint32_t(fieldCount),
		searchable:          (*C.uint8_t)(pinned(&held, request.Searchable)),
		partial_marks:       (*C.uint8_t)(pinned(&held, request.PartialMarks)),
		name_ranks:          (*C.uint16_t)(pinned(&held, request.NameRanks)),
		field_numbers:       (*C.double)(pinned(&held, request.FieldNumbers)),
		lengths:             pinned(&held, columns),
		live:                (*C.uint32_t)(pinned(&held, request.Live)),
		live_words:          uint32Length(len(request.Live)),
		removed:             (*C.uint32_t)(pinned(&held, request.Removed)),
		removed_words:       uint32Length(len(request.Removed)),
		terms:               C.double(request.Terms),
		capacity:            C.uint32_t(request.Capacity),
		total_documents:     C.double(request.TotalDocuments),
		term_match:          C.double(request.TermMatch),
		limit:               C.double(request.Limit),
		min_score:           C.double(request.MinScore),
	}
	if request.HasFilter {
		native.has_filter = 1
		native.filter = (*C.uint32_t)(pinned(&held, request.Filter))
		native.filter_words = uint32Length(len(request.Filter))
	}
	if request.Collect {
		native.collect = 1
	}
	out := C.narsil_keyword_output{
		ordinals:      (*C.int32_t)(pinned(&held, output.Ordinals)),
		scores:        (*C.double)(pinned(&held, output.Scores)),
		length:        uint32Length(min(len(output.Ordinals), len(output.Scores))),
		matched:       (*C.uint32_t)(pinned(&held, output.Matched)),
		matched_words: uint32Length(len(output.Matched)),
	}
	status := C.narsil_keyword_score(w.pointer(), &native, &out)
	runtime.KeepAlive(w)
	outcome := KeywordOutcome{Count: uint32(out.count), TotalMatched: uint32(out.total_matched), ScoringPath: uint32(out.scoring_path)}
	return outcome, statusError("keywordScore", status)
}
