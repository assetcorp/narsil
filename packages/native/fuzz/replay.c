#include "input.h"

#ifndef _WIN32

#include <dirent.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define MAX_REPLAYED_BYTES ((size_t)16 * 1024 * 1024)
#define PATH_BYTES 4096U

static int replay_file(const char *path) {
  FILE *file = fopen(path, "rb");
  if (file == NULL) { return 0; }
  uint8_t *bytes = malloc(MAX_REPLAYED_BYTES);
  size_t length = bytes == NULL ? 0 : fread(bytes, 1, MAX_REPLAYED_BYTES, file);
  int complete = bytes != NULL && feof(file) && !ferror(file);
  int closed = fclose(file) == 0;
  if (complete && closed) {
    uint8_t *exact = malloc(length == 0 ? 1 : length);
    if (exact == NULL) {
      complete = 0;
    } else {
      memcpy(exact, bytes, length);
      (void)LLVMFuzzerTestOneInput(exact, length);
      free(exact);
    }
  }
  free(bytes);
  return complete && closed;
}

static int replay_input(const char *path, size_t *replayed) {
  struct stat status;
  if (stat(path, &status) != 0 || !S_ISREG(status.st_mode)) { return 0; }
  *replayed += 1;
  return replay_file(path);
}

static int replay_path(const char *path, size_t *replayed) {
  struct stat status;
  if (stat(path, &status) != 0) { return 0; }
  if (!S_ISDIR(status.st_mode)) { return replay_input(path, replayed); }
  struct dirent **entries = NULL;
  int count = scandir(path, &entries, NULL, alphasort);
  if (count < 0) { return 0; }
  int replayable = 1;
  for (int at = 0; at < count; at++) {
    if (entries[at]->d_name[0] != '.') {
      char child[PATH_BYTES];
      int written = snprintf(child, sizeof child, "%s/%s", path, entries[at]->d_name);
      if (written < 0 || (size_t)written >= sizeof child || !replay_input(child, replayed)) { replayable = 0; }
    }
    free(entries[at]);
  }
  free((void *)entries);
  return replayable;
}

int main(int argc, char **argv) {
  size_t replayed = 0;
  for (int at = 1; at < argc; at++) {
    if (!replay_path(argv[at], &replayed)) {
      (void)fprintf(stderr, "the replay cannot read %s\n", argv[at]);
      return 1;
    }
  }
  return printf("replayed %zu inputs\n", replayed) < 0;
}

#else

int main(void) { return 0; }

#endif
