#include "dictionary.h"

#include "../analysis/text.h"

#include <stddef.h>
#include <stdint.h>

enum {
  UTF8_CONTINUATION = 0x80,
  UTF8_CONTINUATION_MASK = 0xc0,
  UTF8_PAYLOAD_MASK = 0x3f,
  UTF8_TWO_FIRST = 0xc2,
  UTF8_THREE_FIRST = 0xe0,
  UTF8_FOUR_FIRST = 0xf0,
  UTF8_END = 0xf5,
  UTF8_TWO_MASK = 0x1f,
  UTF8_THREE_MASK = 0x0f,
  UTF8_FOUR_MASK = 0x07,
  UTF8_PAYLOAD_BITS = 6,
  UTF8_THREE_MINIMUM = 0x800,
  UNICODE_END = 0x110000
};

int term_next(term_cursor *cursor, uint32_t *point) {
  if (cursor->at >= cursor->end) { return 0; }
  if (cursor->units != NULL) {
    *point = narsil_decode_next(cursor->units, cursor->end, &cursor->at);
    return 1;
  }
  uint8_t first = cursor->bytes[cursor->at++];
  if (first < NARSIL_ASCII_END) {
    *point = first;
    return 1;
  }
  if (first < UTF8_TWO_FIRST || first >= UTF8_END) { return -1; }
  uint32_t following = 1;
  uint32_t mask = UTF8_TWO_MASK;
  uint32_t minimum = NARSIL_ASCII_END;
  if (first >= UTF8_FOUR_FIRST) {
    following = 3;
    mask = UTF8_FOUR_MASK;
    minimum = NARSIL_SUPPLEMENTARY_FIRST;
  } else if (first >= UTF8_THREE_FIRST) {
    following = 2;
    mask = UTF8_THREE_MASK;
    minimum = UTF8_THREE_MINIMUM;
  }
  uint32_t value = first & mask;
  if (following > cursor->end - cursor->at) { return -1; }
  for (uint32_t at = 0; at < following; at++) {
    uint8_t next = cursor->bytes[cursor->at++];
    if ((next & UTF8_CONTINUATION_MASK) != UTF8_CONTINUATION) { return -1; }
    value = (value << UTF8_PAYLOAD_BITS) | (next & UTF8_PAYLOAD_MASK);
  }
  if (value < minimum || value >= UNICODE_END ||
      (value >= NARSIL_HIGH_SURROGATE_FIRST && value < NARSIL_SURROGATE_END)) {
    return -1;
  }
  *point = value;
  return 1;
}
