#ifndef NARSIL_KEYWORD_REGIONS_H
#define NARSIL_KEYWORD_REGIONS_H

#include "../../include/narsil_keyword.h"

#ifdef __cplusplus
extern "C" {
#endif

int keyword_regions_are_disjoint(const narsil_keyword_request *request, const narsil_keyword_output *output);
int keyword_binding_regions_are_disjoint(const narsil_keyword_request *request, const narsil_keyword_output *output,
                                         const double *settings, size_t settings_count, const double *outcome,
                                         size_t outcome_count);

#ifdef __cplusplus
}
#endif

#endif
