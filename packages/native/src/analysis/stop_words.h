#ifndef NARSIL_ANALYSIS_STOP_WORDS_H
#define NARSIL_ANALYSIS_STOP_WORDS_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint16_t *units;
  uint32_t *offsets;
  uint32_t count;
  uint32_t *slots;
  uint32_t slot_mask;
} narsil_stop_words;

int narsil_stop_words_build(narsil_stop_words *set, const uint16_t *units, const uint32_t *offsets, uint32_t count);
int narsil_stop_words_contains(const narsil_stop_words *set, const uint16_t *units, size_t length);
void narsil_stop_words_release(narsil_stop_words *set);

#endif
