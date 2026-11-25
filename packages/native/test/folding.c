#include "fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_folding.h"

#include <stdint.h>
#include <string.h>

enum { OKO_LENGTH = 3, DAKI_LENGTH = 4, DUONG_LENGTH = 5, RUNNING_LENGTH = 7, RUN_LENGTH = 3, UNKNOWN_FLAG = 1U << 5 };

static uint32_t language_of(const char *name) {
  uint32_t language = UINT32_MAX;
  check(narsil_language_lookup(name, strlen(name), &language) == NARSIL_OK, "folding resolves its language");
  return language;
}

static int folds_to(narsil_analyser *analyser, const char *language, const uint16_t *spelling, uint32_t length,
                    uint32_t flags, const uint16_t *expected, uint32_t expected_length) {
  narsil_term term = {NULL, 0};
  if (narsil_fold_spelling(analyser, language_of(language), spelling, length, flags, &term) != NARSIL_OK) { return 0; }
  return term.length == expected_length && memcmp(term.units, expected, expected_length * sizeof *expected) == 0;
}

void folding_checks(void) {
  narsil_analyser *analyser = NULL;
  check(narsil_analyser_create(&analyser) == NARSIL_OK, "folding allocates an analyser");
  if (analyser == NULL) { return; }
  const uint16_t yoruba_boat[] = {0x1ECD, 'k', 0x1ECD, 0x0300};
  const uint16_t plain_oko[] = {'o', 'k', 'o'};
  check(folds_to(analyser, "yoruba", yoruba_boat, sizeof yoruba_boat / sizeof *yoruba_boat, 0, plain_oko, OKO_LENGTH),
        "folding drops the subdots and the tone mark of a Yoruba word");
  const uint16_t hausa_room[] = {0x0257, 'a', 0x0199, 'i'};
  const uint16_t plain_daki[] = {'d', 'a', 'k', 'i'};
  check(folds_to(analyser, "hausa", hausa_room, DAKI_LENGTH, 0, plain_daki, DAKI_LENGTH),
        "folding replaces the Hausa hooked letters with their plain letters");
  const uint16_t vietnamese_road[] = {0x0111, 0x01B0, 0x1EDD, 'n', 'g'};
  const uint16_t plain_duong[] = {'d', 'u', 'o', 'n', 'g'};
  check(folds_to(analyser, "vietnamese", vietnamese_road, DUONG_LENGTH, 0, plain_duong, DUONG_LENGTH),
        "folding removes the Vietnamese horns and tone marks and replaces the barred d");
  const uint16_t english_running[] = {'r', 'u', 'n', 'n', 'i', 'n', 'g'};
  const uint16_t english_run[] = {'r', 'u', 'n'};
  check(folds_to(analyser, "english", english_running, RUNNING_LENGTH, NARSIL_FOLD_STEM, english_run, RUN_LENGTH),
        "the key of a spelling stems its fold");
  check(folds_to(analyser, "english", english_running, RUNNING_LENGTH, 0, english_running, RUNNING_LENGTH),
        "a fold without stemming keeps a plain ASCII spelling as it is");
  uint32_t folds = UINT32_MAX;
  check(narsil_language_folds(language_of("french"), &folds) == NARSIL_OK && folds == 1, "French sets folding");
  check(narsil_language_folds(language_of("english"), &folds) == NARSIL_OK && folds == 0, "English sets no folding");
  narsil_term term = {NULL, 0};
  check(narsil_fold_spelling(analyser, narsil_language_count(), plain_oko, OKO_LENGTH, 0, &term) ==
            NARSIL_INVALID_ARGUMENT,
        "folding refuses a language that the core does not hold");
  check(narsil_fold_spelling(analyser, language_of("yoruba"), plain_oko, OKO_LENGTH, UNKNOWN_FLAG, &term) ==
            NARSIL_INVALID_ARGUMENT,
        "folding refuses an unknown flag");
  check(narsil_fold_spelling(analyser, language_of("yoruba"), NULL, OKO_LENGTH, 0, &term) == NARSIL_INVALID_ARGUMENT,
        "folding refuses a missing spelling");
  check(narsil_language_folds(narsil_language_count(), &folds) == NARSIL_INVALID_ARGUMENT,
        "the folding test refuses a language that the core does not hold");
  narsil_analyser_destroy(analyser);
}
