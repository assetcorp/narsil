#include "api.h"
#include STEMMER_HEADER

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define CREATE_ENV(name) CREATE_ENV_OF(name)
#define CREATE_ENV_OF(name) name##_create_env
#define STEM(name) STEM_OF(name)
#define STEM_OF(name) name##_stem
#define MAX_WORD_UNITS 65536U

static int read_exact(void *buffer, size_t size) { return fread(buffer, 1, size, stdin) == size; }

int main(void) {
  struct SN_env *env = CREATE_ENV(STEMMER)();
  symbol *word = malloc(MAX_WORD_UNITS * sizeof(symbol));
  if (env == NULL || word == NULL) { return 2; }
  uint32_t length = 0;
  int status = 0;
  while (status == 0 && read_exact(&length, sizeof length)) {
    if (length > MAX_WORD_UNITS || !read_exact(word, length * sizeof(symbol))) {
      status = 3;
    } else if (SN_set_current(env, (int)length, word) < 0 || STEM(STEMMER)(env) < 0 || env->l < 0) {
      status = 4;
    } else {
      uint32_t produced = (uint32_t)env->l;
      if (fwrite(&produced, sizeof produced, 1, stdout) != 1 ||
          fwrite(env->p, sizeof(symbol), produced, stdout) != produced) {
        status = 5;
      }
    }
  }
  SN_delete_env(env);
  free(word);
  return status;
}
