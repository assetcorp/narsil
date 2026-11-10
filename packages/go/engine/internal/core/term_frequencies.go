package core

/*
#include "native/include/narsil_terms.h"

static narsil_status narsil_go_document_frequencies(const narsil_term_dictionary *dictionary, const uint32_t *tokens,
                                                    size_t count, uint32_t *frequencies) {
  for (size_t at = 0; at < count; at++) {
    narsil_status status = narsil_document_frequency(dictionary, tokens[at], &frequencies[at], 1);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}
*/
import "C"

func DocumentFrequencies(dictionary *TermDictionary, tokens, frequencies []uint32) error {
	if dictionary == nil || len(frequencies) < len(tokens) {
		return &StatusError{Operation: "documentFrequency", Status: StatusInvalidArgument}
	}
	if len(tokens) == 0 {
		return nil
	}
	var held pins
	defer held.release()
	holder := dictionary.native(&held)
	status := C.narsil_go_document_frequencies(&holder.dictionary, (*C.uint32_t)(pinned(&held, tokens)),
		C.size_t(len(tokens)), (*C.uint32_t)(pinned(&held, frequencies)))
	return statusError("documentFrequency", status)
}
