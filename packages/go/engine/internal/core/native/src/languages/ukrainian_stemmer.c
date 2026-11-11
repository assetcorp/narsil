#include "../analysis/normalise.h"
#include "../analysis/text.h"
#include "rules.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define NO_MATCH SIZE_MAX
#define LIST_OF(array) {(array), sizeof(array) / sizeof((array)[0])}
#define CYRILLIC_A 0x0430U
#define CYRILLIC_YA 0x044FU

typedef struct {
  const uint16_t *units;
  size_t length;
  size_t rv;
  size_t r2;
} ukrainian_word;

typedef struct {
  const uint16_t *const *suffixes;
  size_t count;
} suffix_list;

static const uint16_t vowels[] = {0x0430, 0x0435, 0x0438, 0x043E, 0x0443, 0x044E, 0x044F, 0x0456, 0x0457, 0x0454};

static const uint16_t *const perfective_gerund_after_a_suffixes[] = {u"вшись", u"вши", u"в"};
static const uint16_t *const perfective_gerund_suffixes[] = {u"івшись", u"ивши", u"ів"};
static const uint16_t *const reflexive_suffixes[] = {u"ся", u"сь"};
static const uint16_t *const adjective_suffixes[] = {
    u"ими", u"ого", u"ому", u"ій", u"ий", u"їй", u"ою", u"ее", u"іе", u"іє", u"ие", u"ої", u"їй",
    u"ем",  u"ім",  u"ом",  u"им", u"их", u"іх", u"ую", u"юю", u"ая", u"яя", u"ое", u"еє",
};
static const uint16_t *const participle_after_a_suffixes[] = {u"ем", u"нн", u"вш", u"ющ", u"щ"};
static const uint16_t *const participle_suffixes[] = {u"івш", u"ивш", u"уюч", u"ующ"};
static const uint16_t *const verb_after_a_suffixes[] = {
    u"ете", u"йте", u"ешь", u"нно", u"ла", u"на", u"ли", u"ем", u"ло",
    u"но",  u"ет",  u"ют",  u"ни",  u"ть", u"й",  u"л",  u"н",
};
static const uint16_t *const verb_suffixes[] = {
    u"ейте", u"уйте", u"ують", u"ила", u"ила", u"ена", u"іте", u"ите", u"или", u"ило", u"ено", u"ять", u"ить",
    u"іть",  u"ішь",  u"ей",   u"уй",  u"ив",  u"ил",  u"ім",  u"им",  u"ен",  u"ує",  u"ую",  u"ю",
};
static const uint16_t *const noun_suffixes[] = {
    u"іями", u"ями", u"іям", u"ієм", u"ією", u"ами", u"еві", u"ові", u"ів", u"їв", u"ій", u"ей", u"ем",
    u"єм",   u"єю",  u"ов",  u"ой",  u"ом",  u"ою",  u"ію",  u"ью",  u"ія", u"ья", u"ям", u"ях", u"ах",
    u"ам",   u"а",   u"е",   u"є",   u"і",   u"ї",   u"и",   u"й",   u"о",  u"у",  u"ь",  u"ю",  u"я",
};
static const uint16_t *const derivational_suffixes[] = {u"ість", u"ость", u"іст", u"ост"};

static const suffix_list perfective_gerund_after_a = LIST_OF(perfective_gerund_after_a_suffixes);
static const suffix_list perfective_gerund = LIST_OF(perfective_gerund_suffixes);
static const suffix_list reflexive = LIST_OF(reflexive_suffixes);
static const suffix_list adjective = LIST_OF(adjective_suffixes);
static const suffix_list participle_after_a = LIST_OF(participle_after_a_suffixes);
static const suffix_list participle = LIST_OF(participle_suffixes);
static const suffix_list verb_after_a = LIST_OF(verb_after_a_suffixes);
static const suffix_list verb = LIST_OF(verb_suffixes);
static const suffix_list noun = LIST_OF(noun_suffixes);
static const suffix_list derivational = LIST_OF(derivational_suffixes);

static int is_vowel(uint16_t unit) {
  for (size_t i = 0; i < sizeof(vowels) / sizeof(vowels[0]); i++) {
    if (vowels[i] == unit) { return 1; }
  }
  return 0;
}

static size_t vowel_then_consonant_after(const ukrainian_word *word, size_t from) {
  for (size_t i = from; i < word->length; i++) {
    if (!is_vowel(word->units[i]) && is_vowel(word->units[i - 1])) { return i + 1; }
  }
  return word->length;
}

static ukrainian_word regions_of(const uint16_t *units, size_t length) {
  ukrainian_word word = {units, length, length, length};
  for (size_t i = 0; i < length; i++) {
    if (is_vowel(units[i])) {
      word.rv = i + 1;
      break;
    }
  }
  size_t region_one = vowel_then_consonant_after(&word, 1);
  word.r2 = vowel_then_consonant_after(&word, region_one + 1);
  return word;
}

static size_t strip(const ukrainian_word *word, size_t length, const uint16_t *suffix, size_t region) {
  size_t suffix_length = narsil_rule_length(suffix);
  if (suffix_length > length || length - suffix_length < region) { return NO_MATCH; }
  if (memcmp(word->units + (length - suffix_length), suffix, suffix_length * sizeof(uint16_t)) != 0) {
    return NO_MATCH;
  }
  return length - suffix_length;
}

static size_t strip_first(const ukrainian_word *word, size_t length, suffix_list list, size_t region) {
  for (size_t i = 0; i < list.count; i++) {
    size_t stripped = strip(word, length, list.suffixes[i], region);
    if (stripped != NO_MATCH) { return stripped; }
  }
  return NO_MATCH;
}

static size_t strip_after_a(const ukrainian_word *word, size_t length, suffix_list list) {
  for (size_t i = 0; i < list.count; i++) {
    size_t stripped = strip(word, length, list.suffixes[i], word->rv);
    if (stripped != NO_MATCH && stripped > 0 &&
        (word->units[stripped - 1] == CYRILLIC_A || word->units[stripped - 1] == CYRILLIC_YA)) {
      return stripped;
    }
  }
  return NO_MATCH;
}

static size_t strip_perfective_gerund(const ukrainian_word *word, size_t length) {
  size_t stripped = strip_after_a(word, length, perfective_gerund_after_a);
  if (stripped != NO_MATCH) { return stripped; }
  return strip_first(word, length, perfective_gerund, word->rv);
}

static size_t strip_adjectival(const ukrainian_word *word, size_t length) {
  size_t adjective_length = strip_first(word, length, adjective, word->rv);
  if (adjective_length == NO_MATCH) { return NO_MATCH; }
  size_t stripped = strip_after_a(word, adjective_length, participle_after_a);
  if (stripped != NO_MATCH) { return stripped; }
  stripped = strip_first(word, adjective_length, participle, word->rv);
  return stripped != NO_MATCH ? stripped : adjective_length;
}

static size_t strip_verb(const ukrainian_word *word, size_t length) {
  size_t stripped = strip_after_a(word, length, verb_after_a);
  if (stripped != NO_MATCH) { return stripped; }
  return strip_first(word, length, verb, word->rv);
}

static size_t strip_inflection(const ukrainian_word *word) {
  size_t stripped = strip_perfective_gerund(word, word->length);
  if (stripped != NO_MATCH) { return stripped; }
  size_t base = strip_first(word, word->length, reflexive, word->rv);
  if (base == NO_MATCH) { base = word->length; }
  stripped = strip_adjectival(word, base);
  if (stripped == NO_MATCH) { stripped = strip_verb(word, base); }
  if (stripped == NO_MATCH) { stripped = strip_first(word, base, noun, word->rv); }
  return stripped != NO_MATCH ? stripped : base;
}

static size_t strip_superlative_and_soft_sign(const ukrainian_word *word, size_t length) {
  size_t stripped = strip(word, length, u"ейше", word->rv);
  if (stripped == NO_MATCH) { stripped = strip(word, length, u"ейш", word->rv); }
  if (stripped == NO_MATCH && strip(word, length, u"нн", word->rv) != NO_MATCH) { stripped = length - 1; }
  if (stripped == NO_MATCH) { stripped = strip(word, length, u"ь", word->rv); }
  return stripped != NO_MATCH ? stripped : length;
}

int narsil_ukrainian_stem(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  ukrainian_word word = regions_of(units, length);
  size_t stemmed = strip_inflection(&word);
  size_t without_i = strip(&word, stemmed, u"и", word.rv);
  if (without_i != NO_MATCH) { stemmed = without_i; }
  size_t derived = strip_first(&word, stemmed, derivational, word.r2);
  if (derived != NO_MATCH) { stemmed = derived; }
  stemmed = strip_superlative_and_soft_sign(&word, stemmed);
  return narsil_text_assign(out, units, stemmed);
}
