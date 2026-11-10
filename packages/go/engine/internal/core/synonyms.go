package core

/*
#include "native/include/narsil_synonyms.h"
*/
import "C"

type SynonymTable struct {
	Tokens     []uint8
	Offsets    []uint32
	RuleStart  []uint32
	RuleSource []int32
	RuleTokens []uint32
	TokenStart []uint32
	TokenRules []uint32
}

type SynonymRequest struct {
	Table  *SynonymTable
	Units  []uint16
	Starts []uint32
}

type SynonymOutput struct {
	Queries []uint32
	Starts  []uint32
	Tokens  []uint32
}

func (t *SynonymTable) valid() bool {
	return len(t.Offsets) > 0 && len(t.RuleStart) == len(t.RuleSource)+1 && len(t.TokenStart) == len(t.Offsets)
}

func ExpandSynonyms(request *SynonymRequest, output *SynonymOutput) (uint32, error) {
	table := request.Table
	if table == nil || !table.valid() || len(request.Starts) == 0 {
		return 0, &StatusError{Operation: "expandSynonyms", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	nativeTable := C.narsil_synonym_table{
		tokens:           (*C.uint8_t)(pinned(&held, table.Tokens)),
		token_bytes:      C.size_t(len(table.Tokens)),
		offsets:          (*C.uint32_t)(pinned(&held, table.Offsets)),
		token_count:      C.size_t(len(table.Offsets) - 1),
		rule_start:       (*C.uint32_t)(pinned(&held, table.RuleStart)),
		rule_source:      (*C.int32_t)(pinned(&held, table.RuleSource)),
		rule_count:       C.size_t(len(table.RuleSource)),
		rule_tokens:      (*C.uint32_t)(pinned(&held, table.RuleTokens)),
		rule_token_count: C.size_t(len(table.RuleTokens)),
		token_start:      (*C.uint32_t)(pinned(&held, table.TokenStart)),
		token_rules:      (*C.uint32_t)(pinned(&held, table.TokenRules)),
		token_rule_count: C.size_t(len(table.TokenRules)),
	}
	tables := []C.narsil_synonym_table{nativeTable}
	native := C.narsil_synonym_request{
		table:       pinned(&held, tables),
		units:       (*C.uint16_t)(pinned(&held, request.Units)),
		unit_count:  C.size_t(len(request.Units)),
		starts:      (*C.uint32_t)(pinned(&held, request.Starts)),
		query_count: C.size_t(len(request.Starts) - 1),
	}
	out := C.narsil_synonym_output{
		queries:        (*C.uint32_t)(pinned(&held, output.Queries)),
		query_capacity: C.size_t(len(output.Queries)),
		starts:         (*C.uint32_t)(pinned(&held, output.Starts)),
		start_capacity: C.size_t(len(output.Starts)),
		tokens:         (*C.uint32_t)(pinned(&held, output.Tokens)),
		token_capacity: C.size_t(len(output.Tokens)),
	}
	var count C.uint32_t
	if err := statusError("expandSynonyms", C.narsil_expand_synonyms(&native, &out, &count)); err != nil {
		return 0, err
	}
	return uint32(count), nil
}
