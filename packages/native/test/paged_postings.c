#include "allocation_failures.h"
#include "fixture.h"

#include "../include/narsil_core.h"

#ifndef _WIN32

#include "../include/narsil_frozen_segments.h"
#include "../include/narsil_paged.h"

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const uint8_t POSTINGS[] = {0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 2, 0, 3, 0, 0, 0, 1, 0, 0, 0};
static const uint8_t CHECKSUM[] = {0x97, 0x13, 0x02, 0x8d};
static const uint8_t POSITIONS[] = {0, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 2, 0, 0, 0};
static const uint8_t OFFSET_CHECKSUM[] = {0xfc, 0x6e, 0x45, 0x2b};
static const uint8_t VALUE_CHECKSUM[] = {0xef, 0x4c, 0x99, 0x02};
static const uint8_t REMOVALS[] = {0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0, 5, 0, 0, 0};
static const uint8_t REMOVAL_OFFSET_CHECKSUM[] = {0x3e, 0x48, 0x40, 0xea};
static const uint8_t REMOVAL_VALUE_CHECKSUM[] = {0xea, 0x6e, 0xde, 0xee};
static const uint8_t IDS[] = {0, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xef, 0xbb, 0xbf, 0xff};
static const uint8_t ID_OFFSET_CHECKSUM[] = {0xdb, 0x56, 0x38, 0x7a};
static const uint8_t ID_VALUE_CHECKSUM[] = {0x79, 0xc2, 0x0c, 0x28};
static const uint8_t WRITE_RECORDS[] = {5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                                        2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0};
static const uint8_t SEQUENCE_CHECKSUM[] = {0x43, 0x96, 0xe2, 0x96};
static const uint8_t TERM_CHECKSUM[] = {0xa8, 0x6e, 0xb1, 0xa7};
static const uint8_t TOTALS[] = {0, 0, 0, 0, 0, 0, 8, 64, 0, 0, 0, 0, 0, 0, 28, 64, 0, 0, 0, 0, 0, 0, 248, 127};
static const uint8_t TOTAL_CHECKSUM[] = {161, 100, 9, 22};

static void total_checks(narsil_workspace *workspace, const narsil_paged_file *file) {
  enum { TOTAL_COUNT = 3, VALID_COUNT = 2 };
  const double second_total = 7;
  narsil_page_section section = {
      file,           sizeof POSTINGS + sizeof POSITIONS + sizeof REMOVALS + sizeof IDS + sizeof WRITE_RECORDS,
      sizeof TOTALS,  NARSIL_PAGE_SLOT_BYTES,
      TOTAL_CHECKSUM, sizeof TOTAL_CHECKSUM};
  double output[TOTAL_COUNT] = {0};
  narsil_page_fault fault = {0};
  check(narsil_read_paged_totals(workspace, NULL, &section, (narsil_paged_totals_request){0, VALID_COUNT}, output,
                                 TOTAL_COUNT, &fault) == NARSIL_OK &&
            output[0] == 3 && output[1] == second_total,
        "paged totals preserve finite stored values");
  memset(output, 0, sizeof output);
  check(narsil_read_paged_totals(workspace, NULL, &section, (narsil_paged_totals_request){0, VALID_COUNT}, output, 1,
                                 &fault) == NARSIL_NEEDS_ROOM &&
            output[0] == 0 && output[1] == 0 && output[2] == 0,
        "short total output remains unchanged");
  check(narsil_read_paged_totals(workspace, NULL, &section, (narsil_paged_totals_request){0, TOTAL_COUNT}, output,
                                 TOTAL_COUNT, &fault) == NARSIL_PAGE_INVALID &&
            output[0] == 0 && output[1] == 0 && output[2] == 0,
        "a malformed later total preserves every output value");
  check(narsil_read_paged_totals(workspace, NULL, &section, (narsil_paged_totals_request){0, VALID_COUNT},
                                 (double *)&fault.file, VALID_COUNT, &fault) == NARSIL_INVALID_ARGUMENT,
        "total output cannot overwrite its fault metadata");
}

static void scalar_checks(narsil_workspace *workspace, const narsil_paged_file *file) {
  enum { DOCUMENTS = 6, RECORD_BYTES = 16, VALUE_WORDS = 2, SEQUENCE = 5 };
  narsil_page_section order = {file, 0, sizeof POSTINGS, NARSIL_PAGE_SLOT_BYTES, CHECKSUM, sizeof CHECKSUM};
  uint32_t ordinal = UINT32_MAX;
  narsil_page_fault fault = {0};
  check(narsil_read_paged_ordinal(workspace, NULL, &order, (narsil_paged_ordinal_request){2, DOCUMENTS}, &ordinal, 1,
                                  &fault) == NARSIL_OK &&
            ordinal == 2,
        "a paged ordinal remains within its document range");
  ordinal = UINT32_MAX;
  check(narsil_read_paged_ordinal(workspace, NULL, &order, (narsil_paged_ordinal_request){0, DOCUMENTS}, &ordinal, 0,
                                  &fault) == NARSIL_NEEDS_ROOM &&
            ordinal == UINT32_MAX,
        "a short ordinal output stays unchanged");
  check(narsil_read_paged_ordinal(workspace, NULL, &order, (narsil_paged_ordinal_request){UINT32_MAX, DOCUMENTS},
                                  &ordinal, 1, &fault) == NARSIL_PAGE_INVALID &&
            ordinal == UINT32_MAX,
        "an ordinal position beyond the section is refused before reading");
  narsil_page_section sequences = {file,
                                   sizeof POSTINGS + sizeof POSITIONS + sizeof REMOVALS + sizeof IDS,
                                   RECORD_BYTES,
                                   NARSIL_PAGE_SLOT_BYTES,
                                   SEQUENCE_CHECKSUM,
                                   sizeof SEQUENCE_CHECKSUM};
  narsil_page_section terms = {file,          sequences.offset + sequences.length,
                               RECORD_BYTES,  NARSIL_PAGE_SLOT_BYTES,
                               TERM_CHECKSUM, sizeof TERM_CHECKSUM};
  narsil_paged_write_request request = {&sequences, &terms, 0};
  uint64_t values[VALUE_WORDS] = {0};
  narsil_paged_write_output output = {values, VALUE_WORDS};
  check(narsil_read_paged_write_record(workspace, NULL, request, output, &fault) == NARSIL_OK &&
            values[0] == SEQUENCE && values[1] == 2,
        "both fields of a paged write record publish together");
  memset(values, 0, sizeof values);
  const uint64_t unchanged[VALUE_WORDS] = {0};
  output.capacity--;
  check(narsil_read_paged_write_record(workspace, NULL, request, output, &fault) == NARSIL_NEEDS_ROOM &&
            memcmp(values, unchanged, sizeof values) == 0,
        "short write record output remains unchanged");
  output.capacity++;
  request.ordinal = UINT32_MAX;
  check(narsil_read_paged_write_record(workspace, NULL, request, output, &fault) == NARSIL_PAGE_INVALID &&
            memcmp(values, unchanged, sizeof values) == 0,
        "a write record beyond the sections cannot read outside them");
  output.values = &fault.file;
  check(narsil_read_paged_write_record(workspace, NULL, request, output, &fault) == NARSIL_INVALID_ARGUMENT,
        "write record output cannot overlap its fault");
}

static void id_checks(narsil_workspace *workspace, const narsil_paged_file *file) {
  enum { OFFSET_WORDS = 3, TEXT_BYTES = 4, BOM_BYTES = 3 };
  narsil_page_section offsets = {file,
                                 sizeof POSTINGS + sizeof POSITIONS + sizeof REMOVALS,
                                 OFFSET_WORDS * sizeof(uint32_t),
                                 NARSIL_PAGE_SLOT_BYTES,
                                 ID_OFFSET_CHECKSUM,
                                 sizeof ID_OFFSET_CHECKSUM};
  narsil_page_section values = {file,
                                offsets.offset + offsets.length,
                                TEXT_BYTES,
                                NARSIL_PAGE_SLOT_BYTES,
                                ID_VALUE_CHECKSUM,
                                sizeof ID_VALUE_CHECKSUM};
  narsil_paged_id_request request = {&offsets, &values, 0};
  uint8_t bytes[TEXT_BYTES] = {0};
  uint32_t length = UINT32_MAX;
  narsil_paged_id_output output = {bytes, sizeof bytes, &length};
  narsil_page_fault fault = {0};
  check(narsil_read_paged_id(workspace, NULL, request, output, &fault) == NARSIL_OK && length == BOM_BYTES &&
            memcmp(bytes, IDS + offsets.length, BOM_BYTES) == 0,
        "paged ID reads preserve a leading UTF-8 byte-order mark");
  memset(bytes, 0, sizeof bytes);
  const uint8_t unchanged[TEXT_BYTES] = {0};
  length = UINT32_MAX;
  output.capacity = BOM_BYTES - 1;
  check(narsil_read_paged_id(workspace, NULL, request, output, &fault) == NARSIL_NEEDS_ROOM && length == UINT32_MAX &&
            memcmp(bytes, unchanged, sizeof bytes) == 0,
        "short ID output preserves the bytes and length");
  output.capacity = sizeof bytes;
  request.ordinal = 1;
  check(narsil_read_paged_id(workspace, NULL, request, output, &fault) == NARSIL_PAGE_INVALID && length == UINT32_MAX &&
            memcmp(bytes, unchanged, sizeof bytes) == 0,
        "invalid UTF-8 cannot publish an ID");
  output.bytes = (uint8_t *)&length;
  check(narsil_read_paged_id(workspace, NULL, request, output, &fault) == NARSIL_INVALID_ARGUMENT &&
            length == UINT32_MAX,
        "the ID bytes cannot overwrite their length");
}

static void paged_settle_checks(narsil_workspace *workspace, const narsil_page_section *offsets,
                                narsil_page_section *values) {
  enum { TOKENS = 3, FIRST_FREQUENCY = 3, SECOND_FREQUENCY = 5 };
  const uint8_t text[] = "abc";
  const uint32_t term_offsets[] = {0, 1, 2, 3};
  const uint32_t term_counts[] = {1, 1, 1};
  const uint32_t slots[] = {0, 1, 2};
  const uint32_t posting_offsets[] = {0, 0, 0, 0};
  narsil_frozen_segment segment = {.terms = {text, sizeof text - 1, term_offsets, term_counts, TOKENS},
                                   .payload_slots = slots,
                                   .posting_offsets = posting_offsets,
                                   .document_count = 1};
  uint32_t bits = 1;
  uint32_t count = 1;
  uint32_t documents[TOKENS] = {0};
  double occurrences[TOKENS] = {0};
  uint32_t header[NARSIL_PENDING_HEADER_WORDS] = {1};
  uint32_t pending[1] = {0};
  narsil_frozen_segment_state state = {.tombstones = &bits,
                                       .tombstone_count = &count,
                                       .removed_documents = documents,
                                       .removed_occurrences = occurrences,
                                       .pending_header = header,
                                       .pending_documents = pending,
                                       .pending_document_capacity = 1};
  narsil_page_fault fault = {0};
  narsil_frozen_paged_removals paged = {NULL, offsets, values, &fault};
  check(narsil_settle_frozen_state(workspace, &segment, &state, &paged) == NARSIL_OK && documents[0] == 1 &&
            documents[1] == 0 && documents[2] == 1 && occurrences[0] == (double)FIRST_FREQUENCY &&
            occurrences[1] == 0 && occurrences[2] == (double)SECOND_FREQUENCY && header[NARSIL_PENDING_DOCUMENTS] == 0,
        "settling a paged segment reads each pending document's removal entry");
  memset(documents, 0, sizeof documents);
  memset(occurrences, 0, sizeof occurrences);
  header[NARSIL_PENDING_DOCUMENTS] = 1;
  values->length -= sizeof(uint32_t);
  check(narsil_settle_frozen_state(workspace, &segment, &state, &paged) == NARSIL_PAGE_INVALID && documents[0] == 0 &&
            documents[2] == 0 && occurrences[0] == 0 && header[NARSIL_PENDING_DOCUMENTS] == 1,
        "a malformed paged removal entry leaves the pending state unsettled");
  values->length += sizeof(uint32_t);
}

static void removal_checks(narsil_workspace *workspace, const narsil_paged_file *file) {
  enum { OFFSET_WORDS = 2, VALUE_WORDS = 4, TOKENS = 3 };
  narsil_page_section offsets = {file,
                                 sizeof POSTINGS + sizeof POSITIONS,
                                 OFFSET_WORDS * sizeof(uint32_t),
                                 NARSIL_PAGE_SLOT_BYTES,
                                 REMOVAL_OFFSET_CHECKSUM,
                                 sizeof REMOVAL_OFFSET_CHECKSUM};
  narsil_page_section values = {file,
                                offsets.offset + offsets.length,
                                VALUE_WORDS * sizeof(uint32_t),
                                NARSIL_PAGE_SLOT_BYTES,
                                REMOVAL_VALUE_CHECKSUM,
                                sizeof REMOVAL_VALUE_CHECKSUM};
  narsil_paged_removal_list list = {&offsets, &values, 0, TOKENS};
  uint32_t output_values[VALUE_WORDS] = {0};
  uint32_t count = UINT32_MAX;
  narsil_paged_removal_output output = {output_values, VALUE_WORDS, &count};
  narsil_page_fault fault = {0};
  const uint32_t expected[] = {0, 3, 2, 5};
  check(narsil_read_paged_removals(workspace, NULL, list, output, &fault) == NARSIL_OK && count == VALUE_WORDS &&
            memcmp(output_values, expected, sizeof expected) == 0,
        "the core reads a removed document's sorted token counts");
  memset(output_values, 0, sizeof output_values);
  const uint32_t unchanged[VALUE_WORDS] = {0};
  count = UINT32_MAX;
  output.capacity--;
  check(narsil_read_paged_removals(workspace, NULL, list, output, &fault) == NARSIL_NEEDS_ROOM && count == UINT32_MAX &&
            memcmp(output_values, unchanged, sizeof unchanged) == 0,
        "short removal output preserves the entries and count");
  output.capacity++;
  values.length -= sizeof(uint32_t);
  check(narsil_read_paged_removals(workspace, NULL, list, output, &fault) == NARSIL_PAGE_INVALID &&
            count == UINT32_MAX && memcmp(output_values, unchanged, sizeof unchanged) == 0,
        "removal offsets outside their section cannot publish counts");
  values.length += sizeof(uint32_t);
  output.count = output_values;
  check(narsil_read_paged_removals(workspace, NULL, list, output, &fault) == NARSIL_INVALID_ARGUMENT &&
            memcmp(output_values, unchanged, sizeof unchanged) == 0,
        "a removal count cannot overwrite its entry output");
  paged_settle_checks(workspace, &offsets, &values);
}

static void position_checks(narsil_workspace *workspace, const narsil_paged_file *file) {
  enum { WORDS = 3, ROWS = 2 };
  narsil_page_section offsets = {
      file, sizeof POSTINGS, WORDS * sizeof(uint32_t), NARSIL_PAGE_SLOT_BYTES, OFFSET_CHECKSUM, sizeof OFFSET_CHECKSUM};
  narsil_page_section values = {file,
                                sizeof POSTINGS + offsets.length,
                                WORDS * sizeof(uint32_t),
                                NARSIL_PAGE_SLOT_BYTES,
                                VALUE_CHECKSUM,
                                sizeof VALUE_CHECKSUM};
  narsil_paged_position_list list = {&offsets, &values, 0, ROWS};
  uint32_t out_offsets[WORDS] = {0};
  uint32_t out_values[WORDS] = {0};
  narsil_paged_position_output output = {out_offsets, WORDS, out_values, WORDS};
  narsil_page_fault fault = {0};
  const uint32_t wanted_offsets[] = {0, 2, 3};
  const uint32_t wanted_values[] = {1, 5, 2};
  check(narsil_read_paged_positions(workspace, NULL, list, output, &fault) == NARSIL_OK &&
            memcmp(out_offsets, wanted_offsets, sizeof out_offsets) == 0 &&
            memcmp(out_values, wanted_values, sizeof out_values) == 0,
        "the core checks and returns positions within each posting");
  memset(out_offsets, 0, sizeof out_offsets);
  memset(out_values, 0, sizeof out_values);
  const uint32_t unchanged[WORDS] = {0};
  output.value_capacity--;
  check(narsil_read_paged_positions(workspace, NULL, list, output, &fault) == NARSIL_NEEDS_ROOM &&
            memcmp(out_offsets, unchanged, sizeof out_offsets) == 0 &&
            memcmp(out_values, unchanged, sizeof out_values) == 0,
        "a short value region preserves both position outputs");
  output.value_capacity++;
  values.length -= sizeof(uint32_t);
  check(narsil_read_paged_positions(workspace, NULL, list, output, &fault) == NARSIL_PAGE_INVALID &&
            memcmp(out_offsets, unchanged, sizeof out_offsets) == 0 &&
            memcmp(out_values, unchanged, sizeof out_values) == 0 && fault.section == offsets.offset,
        "an offset outside the positions fails before either output changes");
  values.length += sizeof(uint32_t);
  output.values = out_offsets;
  check(narsil_read_paged_positions(workspace, NULL, list, output, &fault) == NARSIL_INVALID_ARGUMENT &&
            memcmp(out_offsets, unchanged, sizeof out_offsets) == 0,
        "position output regions cannot overlap");
}

static int write_posting_file(char *path) {
  int descriptor = mkstemp(path);
  if (descriptor < 0) { return 0; }
  FILE *stream = fdopen(descriptor, "wb");
  if (stream == NULL) {
    (void)close(descriptor);
    (void)unlink(path);
    return 0;
  }
  int written = fwrite(POSTINGS, 1, sizeof POSTINGS, stream) == sizeof POSTINGS &&
                fwrite(POSITIONS, 1, sizeof POSITIONS, stream) == sizeof POSITIONS &&
                fwrite(REMOVALS, 1, sizeof REMOVALS, stream) == sizeof REMOVALS &&
                fwrite(IDS, 1, sizeof IDS, stream) == sizeof IDS &&
                fwrite(WRITE_RECORDS, 1, sizeof WRITE_RECORDS, stream) == sizeof WRITE_RECORDS &&
                fwrite(TOTALS, 1, sizeof TOTALS, stream) == sizeof TOTALS;
  int closed = fclose(stream) == 0;
  if (!written || !closed) {
    (void)unlink(path);
    return 0;
  }
  return 1;
}

enum { POSITION_WORDS = 3, POSITION_ROWS = 2, PAGED_PATH_BYTES = 64 };

static const char PAGED_POSTING_PATH[] = "/tmp/narsil-paged-postings-XXXXXX";

typedef struct {
  char path[PAGED_PATH_BYTES];
  narsil_paged_file *file;
  narsil_paged_file *opened;
  uint64_t opened_length;
  uint32_t offsets[POSITION_WORDS];
  uint32_t values[POSITION_WORDS];
  narsil_page_fault fault;
} paged_posting_inputs;

static void release_paged_postings(void *opaque) {
  paged_posting_inputs *inputs = opaque;
  narsil_paged_file_close(inputs->opened);
  narsil_paged_file_close(inputs->file);
  (void)unlink(inputs->path);
  free(inputs);
}

static void *prepare_paged_postings(void) {
  paged_posting_inputs *inputs = calloc(1, sizeof *inputs);
  if (inputs == NULL) { return NULL; }
  memcpy(inputs->path, PAGED_POSTING_PATH, sizeof PAGED_POSTING_PATH);
  if (!write_posting_file(inputs->path)) {
    free(inputs);
    return NULL;
  }
  if (narsil_paged_file_open(inputs->path, &inputs->file) != NARSIL_OK) {
    release_paged_postings(inputs);
    return NULL;
  }
  return inputs;
}

static narsil_status open_refused_file(narsil_workspace *workspace, void *opaque) {
  (void)workspace;
  paged_posting_inputs *inputs = opaque;
  narsil_status status = narsil_paged_file_open(inputs->path, &inputs->opened);
  inputs->opened_length = narsil_paged_file_length(inputs->opened);
  return status;
}

static narsil_status read_refused_positions(narsil_workspace *workspace, void *opaque) {
  paged_posting_inputs *inputs = opaque;
  narsil_page_section offsets = {inputs->file,           sizeof POSTINGS, POSITION_WORDS * sizeof(uint32_t),
                                 NARSIL_PAGE_SLOT_BYTES, OFFSET_CHECKSUM, sizeof OFFSET_CHECKSUM};
  narsil_page_section values = {inputs->file,
                                sizeof POSTINGS + offsets.length,
                                POSITION_WORDS * sizeof(uint32_t),
                                NARSIL_PAGE_SLOT_BYTES,
                                VALUE_CHECKSUM,
                                sizeof VALUE_CHECKSUM};
  narsil_paged_position_list list = {&offsets, &values, 0, POSITION_ROWS};
  narsil_paged_position_output output = {inputs->offsets, POSITION_WORDS, inputs->values, POSITION_WORDS};
  return narsil_read_paged_positions(workspace, NULL, list, output, &inputs->fault);
}

static uint64_t digest_paged_postings(const void *opaque) {
  const paged_posting_inputs *inputs = opaque;
  uint64_t digest = digest_word(DIGEST_START, inputs->opened_length);
  digest = digest_bytes(digest, inputs->offsets, sizeof inputs->offsets);
  digest = digest_bytes(digest, inputs->values, sizeof inputs->values);
  return digest_word(digest_word(digest, inputs->fault.section), inputs->fault.page);
}

void paged_posting_allocation_failures(void) {
  const failing_call calls[] = {
      {"a paged file opening", prepare_paged_postings, open_refused_file, digest_paged_postings,
       release_paged_postings},
      {"a paged position read", prepare_paged_postings, read_refused_positions, digest_paged_postings,
       release_paged_postings},
  };
  for (size_t at = 0; at < sizeof calls / sizeof calls[0]; at++) { refuse_each_allocation(&calls[at]); }
}

void paged_posting_checks(narsil_workspace *workspace) {
  char path[] = "/tmp/narsil-paged-postings-XXXXXX";
  int written = write_posting_file(path);
  narsil_paged_file *file = NULL;
  check(written && narsil_paged_file_open(path, &file) == NARSIL_OK, "the posting fixture is readable");
  if (file == NULL) {
    (void)unlink(path);
    return;
  }
  uint8_t checksums[sizeof CHECKSUM];
  memcpy(checksums, CHECKSUM, sizeof checksums);
  narsil_page_section section = {file, 0, sizeof POSTINGS, NARSIL_PAGE_SLOT_BYTES, checksums, sizeof checksums};
  narsil_paged_posting_list list = {0, 3, 3, 2};
  narsil_page_fault fault = {0};
  uint8_t output[sizeof POSTINGS] = {0};
  check(narsil_read_paged_postings(workspace, NULL, &section, list, output, sizeof output, &fault) == NARSIL_OK &&
            memcmp(output, POSTINGS, sizeof output) == 0,
        "the core reads the posting columns without changing their bytes");
  memset(output, 0, sizeof output);
  const uint8_t unchanged[sizeof POSTINGS] = {0};
  check(narsil_read_paged_postings(workspace, NULL, &section, list, output, sizeof output - 1, &fault) ==
                NARSIL_NEEDS_ROOM &&
            memcmp(output, unchanged, sizeof output) == 0,
        "a short posting output remains unchanged");
  list.documents = 2;
  check(narsil_read_paged_postings(workspace, NULL, &section, list, output, sizeof output, &fault) ==
                NARSIL_PAGE_INVALID &&
            memcmp(output, unchanged, sizeof output) == 0 && fault.file == narsil_paged_file_identity(file),
        "an out-of-range stored ordinal preserves the posting output");
  check(narsil_read_paged_postings(workspace, NULL, &section, list, checksums, sizeof checksums, &fault) ==
                NARSIL_INVALID_ARGUMENT &&
            memcmp(checksums, CHECKSUM, sizeof checksums) == 0,
        "posting output cannot overwrite the live checksums");
  position_checks(workspace, file);
  removal_checks(workspace, file);
  id_checks(workspace, file);
  scalar_checks(workspace, file);
  total_checks(workspace, file);
  narsil_paged_file_close(file);
  check(unlink(path) == 0, "the posting fixture removes its file");
}

#else

void paged_posting_allocation_failures(void) {}

void paged_posting_checks(narsil_workspace *workspace) { (void)workspace; }

#endif
