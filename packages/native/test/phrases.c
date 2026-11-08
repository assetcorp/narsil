#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_phrases.h"

#include <stdint.h>
#include <string.h>

enum { DOCUMENTS = 3, PHRASES = 2, TOKENS = 2, ENTRIES = 3, ROW_CAPACITY = 6, SENTINEL = 99, WORK_UNITS = 17 };

void phrase_checks(narsil_workspace *workspace) {
  uint32_t first_documents[] = {2, 0, 1};
  uint32_t second_documents[] = {0, 1, 2};
  uint16_t fields[] = {0, 0, 0};
  uint32_t starts[] = {0, 1, 2};
  uint32_t counts[] = {1, 1, 1};
  uint32_t first_positions[] = {1, 0, 2};
  uint32_t second_positions[] = {1, 4, 2};
  narsil_phrase_postings postings[] = {
      {first_documents, fields, starts, counts, DOCUMENTS, first_positions, DOCUMENTS, 0},
      {second_documents, fields, starts, counts, DOCUMENTS, second_positions, DOCUMENTS, 1}};
  uint32_t phrase_starts[] = {0, 2, 3};
  uint32_t tokens[] = {0, 1, 1};
  uint32_t offsets[] = {0, 1, 0};
  uint8_t searchable[] = {1};
  uint32_t removed[] = {0};
  int64_t spent = 0;
  uint32_t stop = 0;
  narsil_phrase_request request = {postings,
                                   TOKENS,
                                   phrase_starts,
                                   PHRASES,
                                   tokens,
                                   offsets,
                                   ENTRIES,
                                   searchable,
                                   1,
                                   NULL,
                                   0,
                                   removed,
                                   1,
                                   DOCUMENTS,
                                   1,
                                   {&spent, INT64_MAX, &stop, 0}};
  uint32_t matched = SENTINEL;
  uint32_t output_starts[PHRASES + 1] = {SENTINEL, SENTINEL, SENTINEL};
  uint32_t output_documents[ROW_CAPACITY] = {0};
  uint16_t output_fields[ROW_CAPACITY] = {0};
  uint32_t output_frequencies[ROW_CAPACITY] = {0};
  narsil_phrase_output output = {&matched,           1,
                                 output_starts,      PHRASES + 1,
                                 output_documents,   output_fields,
                                 output_frequencies, ROW_CAPACITY,
                                 ROW_CAPACITY,       ROW_CAPACITY};
  uint32_t row_count = SENTINEL;
  check(narsil_match_phrases(workspace, &request, &output, &row_count) == NARSIL_OK && spent == WORK_UNITS &&
            matched == ((1U << 0) | (1U << 2)) && row_count == 4 && output_starts[0] == 0 && output_starts[1] == 2 &&
            output_starts[2] == 4 && output_documents[0] == 0 && output_documents[1] == 2 && output_documents[2] == 0 &&
            output_documents[3] == 2 && output_frequencies[0] == 1 && output_frequencies[1] == 1 &&
            output_frequencies[2] == 1 && output_frequencies[3] == 1,
        "phrase matching sorts unordered rows, intersects phrases, and counts each positional comparison");
  uint32_t saved_documents[ROW_CAPACITY];
  memcpy(saved_documents, output_documents, sizeof saved_documents);
  spent = 0;
  output.document_capacity = ROW_CAPACITY - 1;
  check(narsil_match_phrases(workspace, &request, &output, &row_count) == NARSIL_NEEDS_ROOM && spent == 0 &&
            memcmp(saved_documents, output_documents, sizeof saved_documents) == 0,
        "phrase output capacity is checked before shared work or output changes");
  output.document_capacity = ROW_CAPACITY;
  tokens[0] = UINT32_MAX;
  check(narsil_match_phrases(workspace, &request, &output, &row_count) == NARSIL_INVALID_ARGUMENT && spent == 0,
        "phrase token references are validated before work");
  tokens[0] = 0;
  output.documents = first_documents;
  output.document_capacity = DOCUMENTS;
  check(narsil_match_phrases(workspace, &request, &output, &row_count) == NARSIL_INVALID_ARGUMENT && spent == 0,
        "phrase outputs cannot overwrite live postings");
  output.documents = output_documents;
  output.document_capacity = ROW_CAPACITY;
}
