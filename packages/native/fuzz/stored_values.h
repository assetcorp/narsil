#ifndef NARSIL_FUZZ_STORED_VALUES_H
#define NARSIL_FUZZ_STORED_VALUES_H

#include "input.h"

#include "../include/narsil_stored_values.h"

#include <stdint.h>

narsil_stored_values fuzz_stored_values(fuzz_input *input, uint32_t documents);

#endif
