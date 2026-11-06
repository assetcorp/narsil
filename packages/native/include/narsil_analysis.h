#ifndef NARSIL_ANALYSIS_H
#define NARSIL_ANALYSIS_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NARSIL_ANALYSE_STEM (1U << 0)
#define NARSIL_ANALYSE_REMOVE_STOP_WORDS (1U << 1)
#define NARSIL_ANALYSE_REMOVE_DIACRITICS (1U << 2)
#define NARSIL_ANALYSE_COLLECT_SURFACES (1U << 3)
#define NARSIL_ANALYSE_SPELLINGS (1U << 4)
#define NARSIL_ANALYSE_FLAGS                                                                                           \
  (NARSIL_ANALYSE_STEM | NARSIL_ANALYSE_REMOVE_STOP_WORDS | NARSIL_ANALYSE_REMOVE_DIACRITICS |                         \
   NARSIL_ANALYSE_COLLECT_SURFACES)
#define NARSIL_TRANSFORM_FLAGS (NARSIL_ANALYSE_STEM | NARSIL_ANALYSE_REMOVE_DIACRITICS)
#define NARSIL_NO_SURFACE UINT32_MAX
#define NARSIL_NO_TERM_SLOT UINT32_MAX
#define NARSIL_MAX_ANALYSED_UNITS (1U << 30)

typedef struct narsil_analyser narsil_analyser;
typedef struct narsil_stop_word_set narsil_stop_word_set;

typedef struct {
  uint32_t position;
  uint32_t term_offset;
  uint32_t term_length;
  uint32_t surface_offset;
  uint32_t surface_length;
  uint32_t original_offset;
  uint32_t original_length;
  uint32_t term_slot;
} narsil_token;

typedef struct {
  const narsil_token *tokens;
  uint32_t token_count;
  const uint16_t *units;
  uint32_t unit_count;
} narsil_tokens;

typedef struct {
  uint32_t language;
  const narsil_stop_word_set *stop_words;
  uint32_t flags;
  const uint16_t *text;
  uint32_t length;
} narsil_analysis_request;

uint32_t narsil_language_count(void);
narsil_status narsil_language_lookup(const char *name, size_t length, uint32_t *language);
const char *narsil_language_name(uint32_t language);
const char *narsil_language_revision(uint32_t language);

narsil_status narsil_analyser_create(narsil_analyser **analyser);
void narsil_analyser_destroy(narsil_analyser *analyser);

narsil_status narsil_stop_word_set_create(const uint16_t *units, const uint32_t *offsets, uint32_t count,
                                          narsil_stop_word_set **set);
void narsil_stop_word_set_destroy(narsil_stop_word_set *set);

typedef struct {
  const uint16_t *units;
  uint32_t length;
} narsil_term;

narsil_status narsil_analyse(narsil_analyser *analyser, const narsil_analysis_request *request, narsil_tokens *tokens);
narsil_status narsil_transform(narsil_analyser *analyser, const narsil_analysis_request *request, narsil_term *term);
typedef struct {
  const uint16_t *units;
  const uint32_t *offsets;
  uint32_t count;
} narsil_word_list;

narsil_status narsil_language_stop_words(uint32_t language, narsil_word_list *words);

#ifdef __cplusplus
}
#endif

#endif
