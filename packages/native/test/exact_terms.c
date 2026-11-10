#include "fixture.h"
#include "segment_fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_segment_merge.h"
#include "../include/narsil_segments.h"
#include "../include/narsil_terms.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum {
  NAMED_WORDS = 10,
  NUMBERED_WORDS = 40,
  INDEXED_WORDS = NAMED_WORDS + NUMBERED_WORDS,
  NUMBERED_LENGTH = 4,
  ABSENT_QUERIES = 14,
  QUERY_COUNT = INDEXED_WORDS + ABSENT_QUERIES,
  QUERY_UNITS = 512,
  FROZEN_TERMS = 64,
  FROZEN_BYTES = 1024,
  FROZEN_ROWS = 128,
  FROZEN_DOCUMENTS = 2,
  FROZEN_LENGTHS = FROZEN_DOCUMENTS * FIELDS,
  SMALLEST_SLOTS = 64,
  WIDER_SLOTS = 256,
  RADIX = 10,
  HIGH_FIRST = 0xd800,
  LOW_FIRST = 0xdc00,
  SURROGATE_END = 0xe000,
  SMILE_HIGH = 0xd83d,
  SMILE_LOW = 0xde00,
  PAYLOAD_BITS = 10,
  SUPPLEMENTARY_FIRST = 0x10000,
  ASCII_END = 0x80,
  TWO_BYTE_END = 0x800,
  CONTINUATION = 0x80,
  CONTINUATION_BITS = 6,
  CONTINUATION_MASK = 0x3f,
  TWO_BYTE_LEAD = 0xc0,
  THREE_BYTE_LEAD = 0xe0,
  FOUR_BYTE_LEAD = 0xf0,
  SLOT_SENTINEL = 77
};

typedef struct {
  uint16_t units[QUERY_UNITS];
  uint32_t offsets[QUERY_COUNT + 1];
  uint32_t count;
} query_list;

typedef struct {
  uint8_t text[FROZEN_BYTES];
  uint32_t offsets[FROZEN_TERMS + 1];
  uint32_t counts[FROZEN_TERMS];
  uint32_t removed[FROZEN_TERMS];
  uint32_t posting_offsets[FROZEN_TERMS + 1];
  uint32_t documents[FROZEN_ROWS];
  uint16_t frequencies[FROZEN_ROWS];
  uint16_t fields[FROZEN_ROWS];
  uint32_t position_offsets[FROZEN_ROWS + 1];
  uint32_t positions[FROZEN_ROWS];
  uint32_t lengths[FROZEN_LENGTHS];
  double totals[FIELDS];
  uint32_t surface_offsets[1];
  uint32_t spelling_offsets[1];
  int32_t slots[WIDER_SLOTS];
  int32_t wider[WIDER_SLOTS];
  narsil_keyword_merge_sizes sizes;
} frozen_fixture;

typedef union {
  int32_t slots[SMALLEST_SLOTS];
  uint32_t words[SMALLEST_SLOTS];
} shared_slots;

static void add_query(query_list *queries, const uint16_t *units, uint32_t length) {
  uint32_t start = queries->offsets[queries->count];
  if (length > 0) { memcpy(queries->units + start, units, length * sizeof *units); }
  queries->count++;
  queries->offsets[queries->count] = start + length;
}

static void add_named_words(query_list *queries) {
  static const uint16_t harbor[] = {'h', 'a', 'r', 'b', 'o', 'r'};
  static const uint16_t harbors[] = {'h', 'a', 'r', 'b', 'o', 'r', 's'};
  static const uint16_t letter[] = {'a'};
  static const uint16_t zebra[] = {'z', 'e', 'b', 'r', 'a'};
  static const uint16_t accented[] = {0x00e9};
  static const uint16_t japanese[] = {0x65e5, 0x672c};
  static const uint16_t smile[] = {SMILE_HIGH, SMILE_LOW};
  static const uint16_t wrapped[] = {'a', SMILE_HIGH, SMILE_LOW, 'b'};
  static const uint16_t first_supplementary[] = {HIGH_FIRST, LOW_FIRST};
  static const uint16_t last_bmp[] = {UINT16_MAX};
  add_query(queries, harbor, sizeof harbor / sizeof *harbor);
  add_query(queries, harbors, sizeof harbors / sizeof *harbors);
  add_query(queries, letter, 1);
  add_query(queries, zebra, sizeof zebra / sizeof *zebra);
  add_query(queries, accented, 1);
  add_query(queries, japanese, 2);
  add_query(queries, smile, 2);
  add_query(queries, wrapped, sizeof wrapped / sizeof *wrapped);
  add_query(queries, first_supplementary, 2);
  add_query(queries, last_bmp, 1);
}

static void add_numbered_word(query_list *queries, uint32_t number) {
  uint16_t word[NUMBERED_LENGTH] = {'t', '0', '0', '0'};
  for (uint32_t at = NUMBERED_LENGTH - 1; at > 0; at--) {
    word[at] = (uint16_t)('0' + (number % RADIX));
    number /= RADIX;
  }
  add_query(queries, word, NUMBERED_LENGTH);
}

static void add_absent_words(query_list *queries) {
  static const uint16_t gone[] = {'g', 'o', 'n', 'e'};
  static const uint16_t shorter[] = {'h', 'a', 'r', 'b', 'o'};
  static const uint16_t longer[] = {'h', 'a', 'r', 'b', 'o', 'r', 's', 's'};
  static const uint16_t other[] = {'b'};
  static const uint16_t upper[] = {'A'};
  static const uint16_t lone_high[] = {SMILE_HIGH};
  static const uint16_t lone_low[] = {SMILE_LOW};
  static const uint16_t reversed[] = {SMILE_LOW, SMILE_HIGH};
  static const uint16_t trailing_high[] = {'a', SMILE_HIGH};
  static const uint16_t high_then_letter[] = {SMILE_HIGH, 'a', SMILE_LOW, 'b'};
  static const uint16_t japanese_prefix[] = {0x65e5};
  static const uint16_t decomposed[] = {'e', 0x0301};
  add_query(queries, gone, sizeof gone / sizeof *gone);
  add_query(queries, shorter, sizeof shorter / sizeof *shorter);
  add_query(queries, longer, sizeof longer / sizeof *longer);
  add_query(queries, other, 1);
  add_query(queries, upper, 1);
  add_query(queries, lone_high, 1);
  add_query(queries, lone_low, 1);
  add_query(queries, reversed, 2);
  add_query(queries, trailing_high, 2);
  add_query(queries, high_then_letter, sizeof high_then_letter / sizeof *high_then_letter);
  add_query(queries, japanese_prefix, 1);
  add_query(queries, decomposed, 2);
  add_query(queries, NULL, 0);
  add_numbered_word(queries, NUMBERED_WORDS);
}

static void build_queries(query_list *queries) {
  memset(queries, 0, sizeof *queries);
  add_named_words(queries);
  for (uint32_t number = 0; number < NUMBERED_WORDS; number++) { add_numbered_word(queries, number); }
  add_absent_words(queries);
}

static narsil_token word_token(const query_list *queries, uint32_t word) {
  uint32_t start = queries->offsets[word];
  uint32_t length = queries->offsets[word + 1] - start;
  return (narsil_token){0, start, length, start, length, 0, 0, NARSIL_NO_TERM_SLOT};
}

static narsil_index_terms_request second_document(segment_fixture *data, const query_list *queries,
                                                  narsil_token tokens[2], narsil_field_tokens *field) {
  tokens[0] = word_token(queries, INDEXED_WORDS);
  tokens[1] = word_token(queries, 0);
  tokens[1].position = 1;
  *field = (narsil_field_tokens){0, {tokens, 2, queries->units, queries->offsets[INDEXED_WORDS + 1]}};
  return (narsil_index_terms_request){&data->segment, 1, field, 1};
}

static void index_words(narsil_workspace *workspace, segment_fixture *data, const query_list *queries) {
  narsil_token tokens[INDEXED_WORDS];
  for (uint32_t at = 0; at < INDEXED_WORDS; at++) {
    tokens[at] = word_token(queries, at);
    tokens[at].position = at;
  }
  narsil_field_tokens indexed = {0, {tokens, INDEXED_WORDS, queries->units, queries->offsets[INDEXED_WORDS + 1]}};
  narsil_index_terms_request request = {&data->segment, 0, &indexed, 1};
  check(narsil_index_terms(workspace, &request) == NARSIL_OK, "the first exact-term document is indexed");
  narsil_token later[2];
  narsil_field_tokens field;
  request = second_document(data, queries, later, &field);
  check(narsil_index_terms(workspace, &request) == NARSIL_OK, "the second exact-term document is indexed");
}

static narsil_merged_strings no_strings(uint32_t *offsets) {
  return (narsil_merged_strings){.offsets = offsets, .offset_capacity = 1};
}

static int freeze(narsil_workspace *workspace, segment_fixture *data, frozen_fixture *frozen) {
  uint32_t mapping[] = {0, 1};
  uint16_t field_mapping[] = {0, 1};
  const uint32_t *lengths[] = {data->field_lengths, data->field_lengths + ORDINALS};
  narsil_keyword_merge_input input = {.mapping = mapping,
                                      .field_mapping = field_mapping,
                                      .field_lengths = lengths,
                                      .document_count = 2,
                                      .field_count = FIELDS,
                                      .growing = &data->segment};
  narsil_keyword_merge_request request = {&input, 1, 2, FIELDS, NULL};
  narsil_keyword_merge_output output = {
      .terms = {frozen->text, frozen->offsets, frozen->counts, FROZEN_TERMS, FROZEN_BYTES, FROZEN_TERMS + 1},
      .posting_offsets = frozen->posting_offsets,
      .posting_offset_capacity = FROZEN_TERMS + 1,
      .posting_documents = frozen->documents,
      .posting_frequencies = frozen->frequencies,
      .posting_fields = frozen->fields,
      .posting_capacity = FROZEN_ROWS,
      .position_offsets = frozen->position_offsets,
      .position_offset_capacity = FROZEN_ROWS + 1,
      .position_values = frozen->positions,
      .position_capacity = FROZEN_ROWS,
      .field_lengths = frozen->lengths,
      .field_length_capacity = FROZEN_LENGTHS,
      .total_field_lengths = frozen->totals,
      .field_count = FIELDS,
      .surfaces = no_strings(frozen->surface_offsets),
      .spellings = no_strings(frozen->spelling_offsets)};
  return narsil_measure_merge(workspace, &request, &frozen->sizes) == NARSIL_OK &&
         narsil_write_merge(workspace, &request, &output) == NARSIL_OK;
}

static size_t encode_utf8(const uint16_t *units, size_t length, uint8_t *bytes) {
  size_t used = 0;
  for (size_t at = 0; at < length; at++) {
    uint32_t point = units[at];
    if (point >= HIGH_FIRST && point < LOW_FIRST && at + 1 < length && units[at + 1] >= LOW_FIRST &&
        units[at + 1] < SURROGATE_END) {
      point = SUPPLEMENTARY_FIRST + ((point - HIGH_FIRST) << PAYLOAD_BITS) + (units[at + 1] - (uint32_t)LOW_FIRST);
      at++;
    }
    if (point < ASCII_END) {
      bytes[used++] = (uint8_t)point;
      continue;
    }
    uint32_t following = 3;
    uint32_t lead = FOUR_BYTE_LEAD;
    if (point < TWO_BYTE_END) {
      following = 1;
      lead = TWO_BYTE_LEAD;
    } else if (point < SUPPLEMENTARY_FIRST) {
      following = 2;
      lead = THREE_BYTE_LEAD;
    }
    bytes[used++] = (uint8_t)(lead | (point >> (following * CONTINUATION_BITS)));
    for (uint32_t step = following; step > 0; step--) {
      bytes[used++] = (uint8_t)(CONTINUATION | ((point >> ((step - 1) * CONTINUATION_BITS)) & CONTINUATION_MASK));
    }
  }
  return used;
}

static int frozen_token_matches(const frozen_fixture *frozen, uint32_t token, const query_list *queries,
                                uint32_t query) {
  if (token >= frozen->sizes.terms) { return 0; }
  uint8_t expected[FROZEN_BYTES];
  uint32_t start = queries->offsets[query];
  size_t length = encode_utf8(queries->units + start, queries->offsets[query + 1] - start, expected);
  uint32_t from = frozen->offsets[token];
  return frozen->offsets[token + 1] - from == length && memcmp(frozen->text + from, expected, length) == 0;
}

static narsil_term_dictionary frozen_dictionary(frozen_fixture *frozen, const int32_t *slots, size_t slot_count) {
  uint32_t terms = frozen->sizes.terms;
  return (narsil_term_dictionary){.tokens = frozen->text,
                                  .token_bytes = frozen->sizes.term_bytes,
                                  .offsets = frozen->offsets,
                                  .offset_count = (size_t)terms + 1,
                                  .frequencies = frozen->counts,
                                  .frequency_count = terms,
                                  .removed = frozen->removed,
                                  .removed_count = terms,
                                  .exact_slots = slots,
                                  .exact_slot_count = slot_count};
}

static void remove_second_document(narsil_workspace *workspace, segment_fixture *data, frozen_fixture *frozen,
                                   const query_list *queries) {
  narsil_token tokens[2];
  narsil_field_tokens field;
  narsil_index_terms_request request = second_document(data, queries, tokens, &field);
  check(narsil_remove_document(workspace, &request) == NARSIL_OK, "the second exact-term document is removed");
  uint32_t words[] = {INDEXED_WORDS, 0};
  for (uint32_t token = 0; token < frozen->sizes.terms; token++) {
    for (size_t at = 0; at < 2; at++) {
      if (frozen_token_matches(frozen, token, queries, words[at])) { frozen->removed[token]++; }
    }
  }
}

static void lookup_all(narsil_workspace *workspace, const narsil_term_dictionary *dictionary, const query_list *queries,
                       uint32_t *found, const char *what) {
  check(narsil_lookup_exact_batch(workspace, dictionary, queries->units, queries->offsets[queries->count],
                                  queries->offsets, (size_t)queries->count + 1, found, queries->count) == NARSIL_OK,
        what);
}

static void compare_lookups(narsil_workspace *workspace, segment_fixture *data, frozen_fixture *frozen,
                            const query_list *queries) {
  narsil_term_dictionary growing = {.growing = &data->segment.terms,
                                    .frequencies = data->frequencies,
                                    .frequency_count = TERMS,
                                    .removed = data->dead,
                                    .removed_count = TERMS};
  narsil_term_dictionary plain = frozen_dictionary(frozen, NULL, 0);
  narsil_term_dictionary hashed = frozen_dictionary(frozen, frozen->slots, SMALLEST_SLOTS);
  narsil_term_dictionary wider = frozen_dictionary(frozen, frozen->wider, WIDER_SLOTS);
  uint32_t found[4][QUERY_COUNT];
  lookup_all(workspace, &growing, queries, found[0], "a growing exact batch succeeds");
  lookup_all(workspace, &plain, queries, found[1], "a frozen exact batch without the hash succeeds");
  lookup_all(workspace, &hashed, queries, found[2], "a frozen exact batch through the smallest hash succeeds");
  lookup_all(workspace, &wider, queries, found[3], "a frozen exact batch through a wider hash succeeds");
  int presence = 1;
  int agreement = 1;
  int spelling = 1;
  for (uint32_t query = 0; query < queries->count; query++) {
    int expected = query < INDEXED_WORDS;
    presence &= (found[0][query] != UINT32_MAX) == expected && (found[1][query] != UINT32_MAX) == expected;
    agreement &= found[1][query] == found[2][query] && found[1][query] == found[3][query];
    if (expected && found[1][query] != UINT32_MAX) {
      spelling &= frozen_token_matches(frozen, found[1][query], queries, query);
    }
    uint32_t single[2] = {UINT32_MAX, UINT32_MAX};
    uint32_t counts[2] = {0, 0};
    uint32_t start = queries->offsets[query];
    narsil_term_lookup request = {
        &hashed, queries->units + start, queries->offsets[query + 1] - start, NARSIL_LOOKUP_TYPO, 0, 0, 0};
    agreement &= narsil_lookup_terms(workspace, &request, &single[0], 1, &counts[0]) == NARSIL_OK;
    request.dictionary = &plain;
    request.operation = NARSIL_LOOKUP_EXACT;
    agreement &= narsil_lookup_terms(workspace, &request, &single[1], 1, &counts[1]) == NARSIL_OK;
    agreement &= counts[0] == counts[1] && single[0] == single[1] && (counts[0] == 1) == expected;
  }
  check(presence, "growing and frozen exact lookups find the same live terms and skip the rest");
  check(agreement, "frozen exact lookups return the same tokens with and without the exact-term hash");
  check(spelling, "every frozen exact lookup returns the token whose UTF-8 encodes the query");
}

static void refuse_bad_builds(frozen_fixture *frozen, segment_fixture *data) {
  narsil_term_dictionary plain = frozen_dictionary(frozen, NULL, 0);
  int32_t probe[SMALLEST_SLOTS];
  for (size_t at = 0; at < SMALLEST_SLOTS; at++) { probe[at] = SLOT_SENTINEL; }
  int32_t built[SMALLEST_SLOTS];
  memcpy(built, frozen->slots, sizeof built);
  narsil_term_dictionary hashed = frozen_dictionary(frozen, frozen->slots, SMALLEST_SLOTS);
  int refused = narsil_build_exact_terms(&plain, probe, SMALLEST_SLOTS - 1) == NARSIL_INVALID_ARGUMENT;
  refused &= narsil_build_exact_terms(&plain, probe, SMALLEST_SLOTS / 2) == NARSIL_INVALID_ARGUMENT;
  refused &= narsil_build_exact_terms(&hashed, frozen->slots, SMALLEST_SLOTS) == NARSIL_INVALID_ARGUMENT;
  int untouched = memcmp(built, frozen->slots, sizeof built) == 0;
  narsil_term_dictionary growing = {.growing = &data->segment.terms,
                                    .frequencies = data->frequencies,
                                    .frequency_count = TERMS,
                                    .removed = data->dead,
                                    .removed_count = TERMS};
  refused &= narsil_build_exact_terms(&growing, probe, SMALLEST_SLOTS) == NARSIL_INVALID_ARGUMENT;
  for (size_t at = 0; at < SMALLEST_SLOTS; at++) { untouched &= probe[at] == SLOT_SENTINEL; }
  check(refused && untouched, "an exact-term build refuses a bad capacity, overlap, or growing table before writing");
}

static void refuse_bad_lookups(narsil_workspace *workspace, frozen_fixture *frozen, const query_list *queries) {
  uint32_t found[QUERY_COUNT];
  narsil_term_dictionary uneven = frozen_dictionary(frozen, frozen->slots, SMALLEST_SLOTS - 1);
  check(narsil_lookup_exact_batch(workspace, &uneven, queries->units, queries->offsets[queries->count],
                                  queries->offsets, (size_t)queries->count + 1, found,
                                  queries->count) == NARSIL_INVALID_ARGUMENT,
        "exact lookups refuse an exact-term hash whose capacity is not a power of two");
  shared_slots shared;
  memcpy(shared.slots, frozen->slots, sizeof shared.slots);
  narsil_term_dictionary hashed = frozen_dictionary(frozen, shared.slots, SMALLEST_SLOTS);
  check(narsil_lookup_exact_batch(workspace, &hashed, queries->units, queries->offsets[queries->count],
                                  queries->offsets, (size_t)queries->count + 1, shared.words,
                                  queries->count) == NARSIL_INVALID_ARGUMENT &&
            memcmp(shared.slots, frozen->slots, sizeof shared.slots) == 0,
        "exact lookups cannot write over the exact-term hash");
  int32_t corrupt[SMALLEST_SLOTS];
  for (size_t at = 0; at < SMALLEST_SLOTS; at++) { corrupt[at] = at % 2 == 0 ? INT32_MAX : -1; }
  narsil_term_dictionary full = frozen_dictionary(frozen, corrupt, SMALLEST_SLOTS);
  int absent = 1;
  lookup_all(workspace, &full, queries, found, "exact lookups probe a hash with no empty slot");
  for (uint32_t query = 0; query < queries->count; query++) { absent &= found[query] == UINT32_MAX; }
  check(absent, "exact lookups skip out-of-range entries and end after one pass over a full hash");
}

void exact_term_checks(narsil_workspace *workspace) {
  segment_fixture *data = create_segment_fixture();
  frozen_fixture *frozen = calloc(1, sizeof *frozen);
  query_list *queries = calloc(1, sizeof *queries);
  check(data != NULL && frozen != NULL && queries != NULL, "the exact-term fixture has memory");
  if (data != NULL && frozen != NULL && queries != NULL) {
    data->partial[0] = 0;
    data->partial[1] = 0;
    build_queries(queries);
    index_words(workspace, data, queries);
    check(freeze(workspace, data, frozen) && frozen->sizes.terms == INDEXED_WORDS + 1,
          "the exact-term segment freezes every indexed word");
    remove_second_document(workspace, data, frozen, queries);
    narsil_term_dictionary plain = frozen_dictionary(frozen, NULL, 0);
    check(narsil_build_exact_terms(&plain, frozen->slots, SMALLEST_SLOTS) == NARSIL_OK &&
              narsil_build_exact_terms(&plain, frozen->wider, WIDER_SLOTS) == NARSIL_OK,
          "the exact-term hash builds at the smallest and a wider capacity");
    compare_lookups(workspace, data, frozen, queries);
    refuse_bad_builds(frozen, data);
    refuse_bad_lookups(workspace, frozen, queries);
  }
  free(queries);
  free(frozen);
  free(data);
}
