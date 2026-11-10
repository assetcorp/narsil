package core

/*
#include <limits.h>
#include <stdlib.h>
#include "native/include/narsil_core.h"
#include "native/src/analysis/languages.h"
#include "native/src/analysis/normalise.h"
#include "native/src/analysis/unicode.h"

typedef struct {
  narsil_normalise_scratch scratch;
  narsil_text composed;
  narsil_text lowered;
  narsil_text stemmed;
  struct SN_env **snowball;
} narsil_go_rewriter;

static const uint16_t narsil_go_rewriter_no_units[1] = {0};

static narsil_go_rewriter *narsil_go_rewriter_create(void) {
  if (narsil_unicode_prepare() != NARSIL_OK) { return NULL; }
  narsil_go_rewriter *rewriter = calloc(1, sizeof(narsil_go_rewriter));
  if (rewriter == NULL) { return NULL; }
  rewriter->snowball = (struct SN_env **)calloc(narsil_language_table_length, sizeof(struct SN_env *));
  if (rewriter->snowball == NULL) {
    free(rewriter);
    return NULL;
  }
  return rewriter;
}

static void narsil_go_rewriter_destroy(narsil_go_rewriter *rewriter) {
  for (uint32_t language = 0; language < narsil_language_table_length; language++) {
    if (rewriter->snowball[language] != NULL) {
      narsil_language_table[language]->close_snowball(rewriter->snowball[language]);
    }
  }
  free((void *)rewriter->snowball);
  narsil_normalise_scratch_release(&rewriter->scratch);
  narsil_text_release(&rewriter->composed);
  narsil_text_release(&rewriter->lowered);
  narsil_text_release(&rewriter->stemmed);
  free(rewriter);
}

static int narsil_go_rewriter_lowercase(narsil_go_rewriter *rewriter, const uint16_t *units, size_t length,
                                        int compose) {
  if (length == 0) { units = narsil_go_rewriter_no_units; }
  if (compose) {
    int status = narsil_nfc(units, length, &rewriter->composed, &rewriter->scratch.points);
    if (status != NARSIL_OK) { return status; }
    length = rewriter->composed.length;
    units = length == 0 ? narsil_go_rewriter_no_units : rewriter->composed.units;
  }
  return narsil_lowercase(units, length, &rewriter->lowered);
}

static int narsil_go_rewriter_stem(narsil_go_rewriter *rewriter, uint32_t language_index, const uint16_t *units,
                                   size_t length, const uint16_t **result, size_t *result_length) {
  if (language_index >= narsil_language_table_length || length > INT_MAX) { return NARSIL_INVALID_ARGUMENT; }
  if (length == 0) { units = narsil_go_rewriter_no_units; }
  const narsil_language *language = narsil_language_table[language_index];
  if (language->stem_by_rules != NULL) {
    int status = language->stem_by_rules(units, length, &rewriter->stemmed, &rewriter->scratch);
    if (status != NARSIL_OK) { return status; }
    *result = rewriter->stemmed.units;
    *result_length = rewriter->stemmed.length;
    return NARSIL_OK;
  }
  if (language->snowball_stem == NULL) {
    int status = narsil_text_assign(&rewriter->stemmed, units, length);
    if (status != NARSIL_OK) { return status; }
    *result = rewriter->stemmed.units;
    *result_length = rewriter->stemmed.length;
    return NARSIL_OK;
  }
  struct SN_env *env = rewriter->snowball[language_index];
  if (env == NULL) {
    env = language->create_snowball();
    if (env == NULL) { return NARSIL_OUT_OF_MEMORY; }
    rewriter->snowball[language_index] = env;
  }
  if (SN_set_current(env, (int)length, units) < 0) { return NARSIL_OUT_OF_MEMORY; }
  if (language->snowball_stem(env) < 0 || env->l < 0) { return NARSIL_OUT_OF_MEMORY; }
  *result = env->p;
  *result_length = (size_t)env->l;
  return NARSIL_OK;
}
*/
import "C"

import (
	"runtime"
	"sync"
	"unsafe"
)

type TokenRewriter struct {
	resources *rewriterResources
}

type rewriterResources struct {
	rewriter *C.narsil_go_rewriter
}

var rewriterPool = sync.Pool{New: newTokenRewriter}

func newTokenRewriter() any {
	created := C.narsil_go_rewriter_create()
	if created == nil {
		return nil
	}
	resources := &rewriterResources{rewriter: created}
	rewriter := &TokenRewriter{resources: resources}
	runtime.AddCleanup(rewriter, releaseRewriterResources, resources)
	return rewriter
}

func releaseRewriterResources(resources *rewriterResources) {
	C.narsil_go_rewriter_destroy(resources.rewriter)
}

func AcquireTokenRewriter() (*TokenRewriter, error) {
	rewriter, _ := rewriterPool.Get().(*TokenRewriter)
	if rewriter == nil {
		return nil, &StatusError{Operation: "rewriterCreate", Status: StatusOutOfMemory}
	}
	return rewriter, nil
}

func (r *TokenRewriter) Release() {
	rewriterPool.Put(r)
}

func unitsPointer(units []uint16) *C.uint16_t {
	return (*C.uint16_t)(sliceStart(units))
}

func copyUnits(pointer *C.uint16_t, length C.size_t) []uint16 {
	copied := make([]uint16, int(length))
	if length > 0 {
		copy(copied, unsafe.Slice((*uint16)(unsafe.Pointer(pointer)), int(length)))
	}
	return copied
}

func (r *TokenRewriter) lowercase(units []uint16, compose bool) ([]uint16, error) {
	var composeFlag C.int
	if compose {
		composeFlag = 1
	}
	status := C.narsil_go_rewriter_lowercase(r.resources.rewriter, unitsPointer(units), C.size_t(len(units)), composeFlag)
	runtime.KeepAlive(units)
	if status != C.NARSIL_OK {
		return nil, statusError("lowercase", C.narsil_status(status))
	}
	lowered := &r.resources.rewriter.lowered
	result := copyUnits(lowered.units, lowered.length)
	runtime.KeepAlive(r)
	return result, nil
}

func (r *TokenRewriter) Lowercase(units []uint16) ([]uint16, error) {
	return r.lowercase(units, false)
}

func (r *TokenRewriter) Stem(language uint32, units []uint16) ([]uint16, error) {
	var result *C.uint16_t
	var length C.size_t
	status := C.narsil_go_rewriter_stem(r.resources.rewriter, C.uint32_t(language), unitsPointer(units), C.size_t(len(units)), &result, &length)
	runtime.KeepAlive(units)
	if status != C.NARSIL_OK {
		return nil, statusError("stem", C.narsil_status(status))
	}
	stemmed := copyUnits(result, length)
	runtime.KeepAlive(r)
	return stemmed, nil
}
