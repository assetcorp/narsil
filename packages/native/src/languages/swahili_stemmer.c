#include "../analysis/normalise.h"
#include "../analysis/text.h"
#include "rules.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define MIN_STEMMED_UNITS 4U
#define MIN_REMAINING_UNITS 3U
#define COUNT_OF(array) (sizeof(array) / sizeof((array)[0]))

static const uint16_t *const subject_prefixes[] = {u"ni", u"tu", u"wa", u"vi", u"zi", u"li", u"ya", u"ku"};
static const uint16_t *const short_subject_prefixes[] = {u"u", u"a", u"i", u"m"};
static const uint16_t *const tense_markers[] = {u"na", u"li", u"ta", u"me", u"ki"};
static const uint16_t *const relative_markers[] = {u"cho", u"vyo", u"ye", u"zo", u"lo", u"yo", u"ko", u"po", u"mo"};
static const uint16_t *const negative_prefixes[] = {u"ha", u"si"};
static const uint16_t *const noun_class_prefixes[] = {u"wa", u"mi", u"ki", u"vi", u"ma"};
static const uint16_t *const short_noun_prefixes[] = {u"m", u"u"};
static const uint16_t *const long_suffixes[] = {u"isha", u"ika", u"ana", u"iwa", u"ewa",
                                                u"aje",  u"ane", u"eni", u"ini"};
static const uint16_t *const short_suffixes[] = {u"wa", u"ia", u"ea"};
static const uint16_t *const final_vowels[] = {u"a", u"i", u"e", u"u"};

typedef struct {
  const uint16_t *units;
  size_t length;
} word_view;

static int remove_prefix(word_view *word, const uint16_t *const *prefixes, size_t prefix_count) {
  for (size_t i = 0; i < prefix_count; i++) {
    size_t length = narsil_rule_length(prefixes[i]);
    if (length <= word->length && word->length - length >= MIN_REMAINING_UNITS &&
        memcmp(word->units, prefixes[i], length * sizeof(uint16_t)) == 0) {
      word->units += length;
      word->length -= length;
      return 1;
    }
  }
  return 0;
}

static int remove_suffix(word_view *word, const uint16_t *const *suffixes, size_t suffix_count) {
  for (size_t i = 0; i < suffix_count; i++) {
    size_t length = narsil_rule_length(suffixes[i]);
    if (length <= word->length && word->length - length >= MIN_REMAINING_UNITS &&
        memcmp(word->units + (word->length - length), suffixes[i], length * sizeof(uint16_t)) == 0) {
      word->length -= length;
      return 1;
    }
  }
  return 0;
}

static void remove_prefixes(word_view *word) {
  size_t original_length = word->length;
  remove_prefix(word, negative_prefixes, COUNT_OF(negative_prefixes));
  int subject_removed = remove_prefix(word, subject_prefixes, COUNT_OF(subject_prefixes));
  if (!subject_removed) {
    subject_removed = remove_prefix(word, short_subject_prefixes, COUNT_OF(short_subject_prefixes));
  }
  if (subject_removed) {
    remove_prefix(word, tense_markers, COUNT_OF(tense_markers));
    remove_prefix(word, relative_markers, COUNT_OF(relative_markers));
    return;
  }
  remove_prefix(word, noun_class_prefixes, COUNT_OF(noun_class_prefixes));
  if (word->length == original_length) { remove_prefix(word, short_noun_prefixes, COUNT_OF(short_noun_prefixes)); }
}

static void remove_suffixes(word_view *word) {
  if (remove_suffix(word, long_suffixes, COUNT_OF(long_suffixes))) { return; }
  if (remove_suffix(word, short_suffixes, COUNT_OF(short_suffixes))) { return; }
  remove_suffix(word, final_vowels, COUNT_OF(final_vowels));
}

int narsil_swahili_stem(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  word_view word = {units, length};
  if (length >= MIN_STEMMED_UNITS) {
    remove_prefixes(&word);
    remove_suffixes(&word);
  }
  return narsil_text_assign(out, word.units, word.length);
}
