#include "../analysis/normalise.h"
#include "../analysis/text.h"
#include "rules.h"

#include <stddef.h>
#include <stdint.h>

#define COMBINING_GRAVE 0x0300U
#define COMBINING_ACUTE 0x0301U
#define COMBINING_CIRCUMFLEX 0x0302U
#define COMBINING_MACRON 0x0304U
#define COMBINING_DOT_ABOVE 0x0307U
#define COMBINING_DIAERESIS 0x0308U
#define COMBINING_HOOK_ABOVE 0x0309U
#define COMBINING_GREEK_YPOGEGRAMMENI 0x0345U

static int is_grave(uint32_t code_point) { return code_point == COMBINING_GRAVE; }

static int is_acute(uint32_t code_point) { return code_point == COMBINING_ACUTE; }

static int is_macron(uint32_t code_point) { return code_point == COMBINING_MACRON; }

static int is_diaeresis(uint32_t code_point) { return code_point == COMBINING_DIAERESIS; }

static int is_slovenian_tone(uint32_t code_point) {
  return code_point >= COMBINING_GRAVE && code_point <= COMBINING_CIRCUMFLEX;
}

static int is_greek_diacritic_other_than_dialytika(uint32_t code_point) {
  return (code_point >= COMBINING_GRAVE && code_point <= COMBINING_DOT_ABOVE) ||
         (code_point >= COMBINING_HOOK_ABOVE && code_point <= COMBINING_GREEK_YPOGEGRAMMENI);
}

int narsil_bulgarian_normalise(const uint16_t *units, size_t length, narsil_text *out,
                               narsil_normalise_scratch *scratch) {
  return narsil_remove_marks(units, length, is_grave, out, scratch);
}

int narsil_danish_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  return narsil_remove_marks(units, length, is_acute, out, scratch);
}

int narsil_greek_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  return narsil_remove_marks(units, length, is_greek_diacritic_other_than_dialytika, out, scratch);
}

int narsil_latin_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  return narsil_remove_marks(units, length, is_macron, out, scratch);
}

int narsil_macedonian_normalise(const uint16_t *units, size_t length, narsil_text *out,
                                narsil_normalise_scratch *scratch) {
  return narsil_remove_marks(units, length, is_grave, out, scratch);
}

int narsil_portuguese_normalise(const uint16_t *units, size_t length, narsil_text *out,
                                narsil_normalise_scratch *scratch) {
  return narsil_remove_marks(units, length, is_diaeresis, out, scratch);
}

int narsil_slovenian_normalise(const uint16_t *units, size_t length, narsil_text *out,
                               narsil_normalise_scratch *scratch) {
  return narsil_remove_marks(units, length, is_slovenian_tone, out, scratch);
}
