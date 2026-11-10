#include "fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_highlight.h"

#include <stdint.h>
#include <string.h>

enum { TEXT_LENGTH = 7, SNIPPET_LENGTH = 9, STEM_LENGTH = 3, UNCHANGED = 41 };

void highlight_checks(narsil_workspace *workspace) {
  narsil_analyser *analyser = NULL;
  check(narsil_analyser_create(&analyser) == NARSIL_OK, "highlighting allocates an analyser");
  if (analyser == NULL) { return; }
  uint32_t language = 0;
  check(narsil_language_lookup("english", TEXT_LENGTH, &language) == NARSIL_OK, "highlighting resolves English");
  uint16_t text[] = {'r', 'u', 'n', 'n', 'i', 'n', 'g'};
  const uint16_t term[] = {'r', 'u', 'n'};
  const uint16_t before[] = {'['};
  const uint16_t after[] = {']'};
  const uint16_t expected[] = {'[', 'r', 'u', 'n', 'n', 'i', 'n', 'g', ']'};
  narsil_highlight_term query_term = {{term, STEM_LENGTH}, 0};
  narsil_highlight_query query = {&query_term, 1, 0, {NULL, 0}, NULL, 0, NULL, 0};
  narsil_highlight_request request = {language, {text, TEXT_LENGTH}, query, {before, 1}, {after, 1}, 0};
  uint16_t snippet[SNIPPET_LENGTH] = {0};
  uint32_t positions[2] = {0};
  uint32_t length = 0;
  uint32_t count = 0;
  narsil_highlight_output output = {snippet, SNIPPET_LENGTH, positions, 2, &length, 1};
  check(narsil_highlight(analyser, workspace, &request, &output, &count) == NARSIL_OK && count == 1 &&
            length == SNIPPET_LENGTH && positions[0] == 0 && positions[1] == TEXT_LENGTH &&
            memcmp(snippet, expected, sizeof expected) == 0,
        "highlighting publishes the snippet and original offsets");
  output.snippet_capacity = 0;
  length = count = positions[0] = positions[1] = UNCHANGED;
  check(narsil_highlight(analyser, workspace, &request, &output, &count) == NARSIL_NEEDS_ROOM && length == UNCHANGED &&
            count == UNCHANGED && positions[0] == UNCHANGED && positions[1] == UNCHANGED &&
            memcmp(snippet, expected, sizeof expected) == 0,
        "a short snippet region preserves every output");
  output.snippet = text;
  output.snippet_capacity = TEXT_LENGTH;
  check(narsil_highlight(analyser, workspace, &request, &output, &count) == NARSIL_INVALID_ARGUMENT &&
            length == UNCHANGED && count == UNCHANGED && text[0] == 'r',
        "highlighting refuses an output that overlaps live input");
  output.snippet = snippet;
  output.snippet_capacity = SNIPPET_LENGTH;
  request.query.terms = NULL;
  check(narsil_highlight(analyser, workspace, &request, &output, &count) == NARSIL_INVALID_ARGUMENT &&
            count == UNCHANGED && length == UNCHANGED && memcmp(snippet, expected, sizeof expected) == 0,
        "highlighting refuses missing query metadata before dereferencing it");
  narsil_analyser_destroy(analyser);
}
