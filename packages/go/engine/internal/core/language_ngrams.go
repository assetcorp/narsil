package core

/*
#include <stdint.h>
#include "native/src/analysis/languages.h"

static uint32_t narsil_go_language_ngram_size(uint32_t language) {
  if (language >= narsil_language_table_length) { return 0; }
  return narsil_language_table[language]->ngram_size;
}
*/
import "C"

func LanguageNgramSize(language uint32) uint32 {
	return uint32(C.narsil_go_language_ngram_size(C.uint32_t(language)))
}
