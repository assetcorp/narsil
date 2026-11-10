#include "file.h"
#include "input.h"

#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum {
  MAX_SLOTS = 24,
  MAX_M = 4,
  MAX_DIMENSION = 8,
  VECTOR_ALIGNMENT_FLOATS = 4,
  THREAD_SLOTS = 2,
  CODE_WIDTHS = 5,
  METRIC_CHOICES = 4,
  MAX_LAYERS = 4,
  MAX_FILE_BYTES = 2048,
  MAX_OPERATIONS = 6,
  OPERATION_KINDS = 8,
  MAX_ORDINALS = 8
};

enum { SEARCH, SCORE, MEASURE, QUANTISE, PLACE, REMOVE, COMPACT, CONNECT };

static const uint32_t CODE_WIDTH_CHOICES[CODE_WIDTHS] = {0, 1, 2, 4, 8};

typedef struct {
  narsil_graph graph;
  narsil_store store;
  narsil_vector_file file;
  uint32_t slots;
  uint32_t dimension;
  int32_t *header;
  uint8_t *code_block;
  const float *vector_block;
} graph_inputs;

static int32_t fuzz_ordinal(fuzz_input *input, uint32_t slots) {
  return fuzz_raw(input) ? (int32_t)fuzz_u32(input) : (int32_t)fuzz_below(input, slots + 2) - 1;
}

typedef struct {
  size_t lists;
  uint32_t list_words;
} list_layout;

static int32_t *fuzz_lists(fuzz_input *input, list_layout layout, uint32_t slots) {
  int32_t *words = FUZZ_ARRAY(input, int32_t, layout.lists *layout.list_words);
  if (words == NULL || fuzz_raw(input)) { return words; }
  for (size_t list = 0; list < layout.lists; list++) {
    int32_t *row = words + (list * layout.list_words);
    row[0] = (int32_t)((uint32_t)row[0] % (layout.list_words - 1));
    for (uint32_t word = 1; word < layout.list_words; word++) {
      row[word] = (int32_t)((uint32_t)row[word] % (slots + 1)) - (row[word] < 0 ? 1 : 0);
    }
  }
  return words;
}

static uint8_t *fuzz_flags(fuzz_input *input, uint32_t count) {
  uint8_t *flags = FUZZ_ARRAY(input, uint8_t, count);
  for (uint32_t at = 0; flags != NULL && !fuzz_raw(input) && at < count; at++) { flags[at] &= 1U; }
  return flags;
}

static void build_graph(fuzz_input *input, graph_inputs *built) {
  uint32_t neighbours = 1 + fuzz_below(input, MAX_M);
  uint32_t base_neighbours = neighbours * 2;
  uint32_t slots = built->slots;
  uint32_t upper_capacity = slots * (neighbours + NARSIL_LIST_WORDS_OVER_NEIGHBOURS) * 2;
  int32_t *header = FUZZ_ROOM(input, int32_t, NARSIL_GRAPH_HEADER_WORDS);
  if (header == NULL) { return; }
  memset(header, 0, NARSIL_GRAPH_HEADER_WORDS * sizeof *header);
  header[NARSIL_GRAPH_WORD_ENTRY_POINT] = fuzz_ordinal(input, slots);
  header[NARSIL_GRAPH_WORD_TOP_LAYER] =
      fuzz_raw(input) ? (int32_t)fuzz_u32(input) : (int32_t)fuzz_below(input, MAX_LAYERS) - 1;
  header[NARSIL_GRAPH_WORD_M] = (int32_t)neighbours;
  header[NARSIL_GRAPH_WORD_MMAX0] = (int32_t)base_neighbours;
  header[NARSIL_GRAPH_WORD_EF_CONSTRUCTION] = (int32_t)(1 + fuzz_below(input, MAX_SLOTS));
  header[NARSIL_GRAPH_WORD_NODE_COUNT] = (int32_t)fuzz_below(input, slots + 1);
  header[NARSIL_GRAPH_WORD_TOMBSTONE_COUNT] = (int32_t)fuzz_below(input, slots + 1);
  header[NARSIL_GRAPH_WORD_UPPER_USED] = (int32_t)fuzz_below(input, upper_capacity + 1);
  header[NARSIL_GRAPH_WORD_SLOTS] = (int32_t)fuzz_below(input, slots + 1);
  header[NARSIL_GRAPH_WORD_UPPER_CAPACITY] = (int32_t)upper_capacity;
  header[NARSIL_GRAPH_WORD_SLOT_CAPACITY] = (int32_t)slots;
  int32_t *upper_base = FUZZ_ARRAY(input, int32_t, slots);
  for (uint32_t at = 0; upper_base != NULL && !fuzz_raw(input) && at < slots; at++) {
    upper_base[at] = (int32_t)((uint32_t)upper_base[at] % (upper_capacity + 1));
  }
  uint8_t *levels = FUZZ_ARRAY(input, uint8_t, slots);
  for (uint32_t at = 0; levels != NULL && !fuzz_raw(input) && at < slots; at++) { levels[at] %= MAX_LAYERS + 1; }
  built->header = header;
  list_layout base_layout = {slots, base_neighbours + NARSIL_LIST_WORDS_OVER_NEIGHBOURS};
  uint32_t upper_words = neighbours + NARSIL_LIST_WORDS_OVER_NEIGHBOURS;
  list_layout upper_layout = {upper_capacity / upper_words, upper_words};
  built->graph = (narsil_graph){header,
                                levels,
                                fuzz_lists(input, base_layout, slots),
                                upper_base,
                                fuzz_lists(input, upper_layout, slots),
                                FUZZ_ROOM(input, int32_t, slots),
                                fuzz_flags(input, slots),
                                FUZZ_ARRAY(input, int32_t, slots),
                                fuzz_flags(input, slots),
                                FUZZ_ROOM(input, int32_t, (size_t)THREAD_SLOTS *NARSIL_HELD_WORDS_PER_THREAD),
                                THREAD_SLOTS,
                                NULL,
                                NULL};
  if (built->graph.locks != NULL) { memset(built->graph.locks, 0, slots * sizeof(int32_t)); }
  if (built->graph.held_locks != NULL) {
    memset(built->graph.held_locks, 0, (size_t)THREAD_SLOTS * NARSIL_HELD_WORDS_PER_THREAD * sizeof(int32_t));
  }
}

static int32_t *fuzz_vector_files(fuzz_input *input, uint32_t slots) {
  int32_t *files = FUZZ_ARRAY(input, int32_t, slots);
  for (uint32_t at = 0; files != NULL && !fuzz_raw(input) && at < slots; at++) {
    files[at] = (int32_t)((uint32_t)files[at] % 3) - 1;
  }
  return files;
}

static int64_t *fuzz_sequences(fuzz_input *input, uint32_t slots) {
  int64_t *sequences = FUZZ_ARRAY(input, int64_t, slots);
  for (uint32_t at = 0; sequences != NULL && !fuzz_raw(input) && at < slots; at++) {
    sequences[at] = sequences[at] & 3;
  }
  return sequences;
}

static void build_store(fuzz_input *input, graph_inputs *built) {
  uint32_t slots = built->slots;
  uint32_t dimension = built->dimension;
  uint32_t bits = CODE_WIDTH_CHOICES[fuzz_below(input, CODE_WIDTHS)];
  uint32_t record_bytes = narsil_record_bytes(dimension, bits);
  uint32_t stride = ((dimension + VECTOR_ALIGNMENT_FLOATS - 1) / VECTOR_ALIGNMENT_FLOATS) * VECTOR_ALIGNMENT_FLOATS;
  int32_t *header = FUZZ_ROOM(input, int32_t, NARSIL_STORE_HEADER_WORDS);
  if (header == NULL) { return; }
  memset(header, 0, NARSIL_STORE_HEADER_WORDS * sizeof *header);
  header[NARSIL_STORE_WORD_SLOTS] = (int32_t)fuzz_below(input, slots + 1);
  header[NARSIL_STORE_WORD_LIVE_COUNT] = (int32_t)fuzz_below(input, slots + 1);
  header[NARSIL_STORE_WORD_CALIBRATED] = (int32_t)fuzz_below(input, 3);
  header[NARSIL_STORE_WORD_CODE_COUNT] = (int32_t)fuzz_below(input, slots + 1);
  built->code_block = FUZZ_ARRAY(input, uint8_t, (size_t)record_bytes *slots);
  built->vector_block = FUZZ_ARRAY(input, float, (size_t)stride *slots);
  int64_t *pins = FUZZ_ROOM(input, int64_t, THREAD_SLOTS);
  if (pins != NULL) { memset(pins, 0, THREAD_SLOTS * sizeof *pins); }
  size_t file_bytes = fuzz_below(input, MAX_FILE_BYTES + 1);
  const uint8_t *file_contents = FUZZ_ARRAY(input, uint8_t, file_bytes);
  const char *path = input->exhausted_memory ? NULL : fuzz_file_write(file_contents, file_bytes);
  uint32_t file_count = path != NULL && narsil_vector_file_map(path, &built->file) == NARSIL_OK ? 1 : 0;
  built->store = (narsil_store){header,
                                dimension,
                                bits,
                                &built->code_block,
                                bits == 0 ? 0 : 1,
                                slots,
                                fuzz_flags(input, slots),
                                FUZZ_ARRAY(input, float, dimension),
                                &built->vector_block,
                                1,
                                slots,
                                stride,
                                fuzz_numbers(input, slots),
                                fuzz_flags(input, slots),
                                fuzz_vector_files(input, slots),
                                FUZZ_ARRAY(input, uint32_t, slots),
                                &built->file,
                                file_count,
                                fuzz_sequences(input, slots),
                                fuzz_sequences(input, slots),
                                pins,
                                THREAD_SLOTS};
}

static narsil_status search(narsil_workspace *workspace, fuzz_input *input, const graph_inputs *built) {
  uint32_t capacity = 1 + fuzz_below(input, built->slots + 1);
  uint32_t accepted_bytes = (fuzz_byte(input) & 1U) == 0 ? 0 : (uint32_t)fuzz_bit_bytes(built->slots);
  narsil_search_request request = {FUZZ_ARRAY(input, float, built->dimension),
                                   fuzz_below(input, METRIC_CHOICES),
                                   capacity,
                                   fuzz_below(input, THREAD_SLOTS + 1),
                                   {FUZZ_ARRAY(input, uint8_t, accepted_bytes), accepted_bytes},
                                   (int64_t)fuzz_below(input, 4)};
  narsil_candidates nearest = {FUZZ_ROOM(input, int32_t, capacity), FUZZ_ROOM(input, double, capacity), capacity, 0};
  if (input->exhausted_memory) { return NARSIL_OUT_OF_MEMORY; }
  return narsil_search(workspace, &built->graph, &built->store, &request, &nearest);
}

static narsil_ordinals_request fuzz_ordinals(fuzz_input *input, uint32_t slots) {
  uint32_t count = fuzz_below(input, MAX_ORDINALS + 1);
  int32_t *ordinals = FUZZ_ROOM(input, int32_t, count);
  for (uint32_t at = 0; ordinals != NULL && at < count; at++) { ordinals[at] = fuzz_ordinal(input, slots); }
  return (narsil_ordinals_request){fuzz_below(input, METRIC_CHOICES), ordinals, count};
}

static narsil_status score(narsil_workspace *workspace, fuzz_input *input, const graph_inputs *built) {
  narsil_ordinals_request ordinals = fuzz_ordinals(input, built->slots);
  narsil_score_request request = {FUZZ_ARRAY(input, float, built->dimension), ordinals.metric, ordinals.ordinals,
                                  ordinals.count, (int64_t)fuzz_below(input, 4)};
  double *distances = FUZZ_ROOM(input, double, ordinals.count);
  if (input->exhausted_memory) { return NARSIL_OUT_OF_MEMORY; }
  return narsil_score(workspace, &built->store, &request, distances);
}

static narsil_status record_work(narsil_workspace *workspace, fuzz_input *input, const graph_inputs *built,
                                 uint32_t operation) {
  narsil_ordinals_request request = fuzz_ordinals(input, built->slots);
  double *totals = fuzz_numbers(input, (size_t)built->dimension + 2);
  if (input->exhausted_memory) { return NARSIL_OUT_OF_MEMORY; }
  return operation == MEASURE ? narsil_measure(workspace, &built->store, &request, totals)
                              : narsil_quantise(workspace, &built->store, &request);
}

static narsil_status write_graph(narsil_workspace *workspace, fuzz_input *input, const graph_inputs *built,
                                 uint32_t operation) {
  uint32_t held_alone = (operation != REMOVE && (fuzz_byte(input) & 1U) == 1U) ? 1U : 0U;
  built->header[NARSIL_GRAPH_WORD_LOCK] = held_alone ? NARSIL_GRAPH_HELD_ALONE : 0;
  uint32_t metric = fuzz_below(input, METRIC_CHOICES);
  uint32_t thread_slot = fuzz_below(input, THREAD_SLOTS + 1);
  narsil_status status = NARSIL_OK;
  if (operation == PLACE) {
    narsil_place_request request = {metric, fuzz_ordinal(input, built->slots),
                                    (int32_t)fuzz_below(input, MAX_LAYERS + 1) - 1, thread_slot, held_alone};
    status = narsil_place(workspace, &built->graph, &built->store, &request);
  } else if (operation == REMOVE) {
    narsil_remove_request request = {fuzz_ordinal(input, built->slots), thread_slot};
    status = narsil_remove(&built->graph, &request);
  } else if (operation == COMPACT) {
    narsil_compact_request request = {metric, thread_slot};
    status = narsil_compact(workspace, &built->graph, &built->store, &request);
  } else {
    narsil_ordinals_request nearby = fuzz_ordinals(input, built->slots);
    narsil_connect_request request = {metric, thread_slot, nearby.ordinals, nearby.count};
    status = input->exhausted_memory ? NARSIL_OUT_OF_MEMORY
                                     : narsil_connect_unreached(workspace, &built->graph, &built->store, &request);
  }
  built->header[NARSIL_GRAPH_WORD_LOCK] = 0;
  return status;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  graph_inputs built;
  memset(&built, 0, sizeof built);
  built.slots = 1 + fuzz_below(&input, MAX_SLOTS);
  built.dimension = 1 + fuzz_below(&input, MAX_DIMENSION);
  build_graph(&input, &built);
  build_store(&input, &built);
  uint32_t operations = 1 + fuzz_below(&input, MAX_OPERATIONS);
  for (uint32_t at = 0; at < operations && !input.exhausted_memory && built.header != NULL; at++) {
    uint32_t operation = fuzz_below(&input, OPERATION_KINDS);
    if (operation == SEARCH) {
      (void)search(workspace, &input, &built);
    } else if (operation == SCORE) {
      (void)score(workspace, &input, &built);
    } else if (operation == MEASURE || operation == QUANTISE) {
      (void)record_work(workspace, &input, &built, operation);
    } else {
      (void)write_graph(workspace, &input, &built, operation);
    }
  }
  narsil_vector_file_unmap(&built.file);
  narsil_workspace_destroy(workspace);
  fuzz_release(&input);
  return 0;
}
