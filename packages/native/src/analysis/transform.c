#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../languages/snowball/api.h"
#include "analyser.h"
#include "languages.h"
#include "normalise.h"
#include "text.h"

#include <limits.h>
#include <stddef.h>
#include <stdint.h>

static narsil_text *buffer_apart_from(narsil_analyser *analyser, narsil_unit_view current) {
  if (current.units != NULL && current.units == analyser->step_a.units) { return &analyser->step_b; }
  return &analyser->step_a;
}

static narsil_unit_view view_of(const narsil_text *text) {
  narsil_unit_view view = {text->units, text->length};
  return view;
}

static int rewrite(narsil_analyser *analyser, narsil_token_rewrite step, narsil_unit_view *current) {
  narsil_text *target = buffer_apart_from(analyser, *current);
  int status = step(current->units, current->length, target, &analyser->scratch);
  if (status == NARSIL_OK) { *current = view_of(target); }
  return status;
}

static int strip_diacritics(narsil_analyser *analyser, narsil_unit_view *current) {
  narsil_text *target = buffer_apart_from(analyser, *current);
  int status = narsil_strip_diacritics(current->units, current->length, target, &analyser->scratch.points);
  if (status == NARSIL_OK) { *current = view_of(target); }
  return status;
}

static int stem_with_snowball(narsil_analyser *analyser, const narsil_language *language, uint32_t language_index,
                              narsil_unit_view *current) {
  if (current->length > INT_MAX) { return NARSIL_INVALID_ARGUMENT; }
  struct SN_env *env = analyser->snowball[language_index];
  if (env == NULL) {
    env = language->create_snowball();
    if (env == NULL) { return NARSIL_OUT_OF_MEMORY; }
    analyser->snowball[language_index] = env;
  }
  if (SN_set_current(env, (int)current->length, current->units) < 0) { return NARSIL_OUT_OF_MEMORY; }
  if (language->snowball_stem(env) < 0 || env->l < 0) { return NARSIL_OUT_OF_MEMORY; }
  current->units = env->p;
  current->length = (size_t)env->l;
  return NARSIL_OK;
}

int narsil_transform_token(narsil_analyser *analyser, const narsil_language *language, uint32_t language_index,
                           narsil_unit_view candidate, uint32_t flags, narsil_unit_view *result) {
  narsil_unit_view current = candidate;
  int status = NARSIL_OK;
  if (language->normalise != NULL) { status = rewrite(analyser, language->normalise, &current); }
  if (status == NARSIL_OK && (flags & NARSIL_ANALYSE_REMOVE_DIACRITICS) != 0) {
    status = strip_diacritics(analyser, &current);
  }
  if (status == NARSIL_OK && (flags & NARSIL_ANALYSE_STEM) != 0) {
    if (language->stem_by_rules != NULL) {
      status = rewrite(analyser, language->stem_by_rules, &current);
    } else if (language->snowball_stem != NULL) {
      status = stem_with_snowball(analyser, language, language_index, &current);
    }
  }
  if (status == NARSIL_OK) { *result = current; }
  return status;
}

int narsil_surface_of(narsil_analyser *analyser, const narsil_language *language, narsil_unit_view candidate,
                      narsil_unit_view *result) {
  narsil_unit_view current = candidate;
  if (language->normalise != NULL) {
    int status = language->normalise(current.units, current.length, &analyser->surface_step, &analyser->scratch);
    if (status != NARSIL_OK) { return status; }
    current = view_of(&analyser->surface_step);
  }
  int status = narsil_strip_diacritics(current.units, current.length, &analyser->surface, &analyser->scratch.points);
  if (status == NARSIL_OK) { *result = view_of(&analyser->surface); }
  return status;
}
