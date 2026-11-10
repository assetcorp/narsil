#include "paged_async.h"

#include "../include/narsil_core.h"
#include "../include/narsil_paged.h"
#include "../include/narsil_paged_vectors.h"
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static void *copy_region(paged_async_job *job, const void *source, size_t count, size_t width) {
  if (width == 0 || count > SIZE_MAX / width) { return NULL; }
  size_t bytes = count * width;
  paged_owned *entry = malloc(sizeof *entry);
  if (entry == NULL) { return NULL; }
  entry->bytes = calloc(count == 0 ? 1 : count, width);
  if (entry->bytes == NULL) {
    free(entry);
    return NULL;
  }
  if (bytes > 0) { memcpy(entry->bytes, source, bytes); }
  entry->next = job->owned;
  job->owned = entry;
  return entry->bytes;
}

int copy_paged_section(paged_async_job *job, narsil_page_section *section) {
  section->checksums = copy_region(job, section->checksums, section->checksum_bytes, 1);
  return section->checksums != NULL;
}

static int copy_files(paged_async_job *job) {
  if (job->field.file_count == 0) { return 1; }
  narsil_paged_vector_file *files = copy_region(job, job->field.files, job->field.file_count, sizeof *files);
  if (files == NULL) { return 0; }
  job->field.files = files;
  for (size_t at = 0; at < job->field.file_count; at++) {
    narsil_paged_vector_file *file = &files[at];
    if (file->dead != NULL) {
      file->dead = copy_region(job, file->dead, file->dead_bytes, 1);
      if (file->dead == NULL) { return 0; }
    }
    if (!copy_paged_section(job, &file->vectors)) { return 0; }
    if (file->records != NULL) {
      narsil_page_section *records = copy_region(job, file->records, 1, sizeof *records);
      if (records == NULL || !copy_paged_section(job, records)) { return 0; }
      file->records = records;
    }
  }
  return 1;
}

static int copy_parts(paged_async_job *job) {
  if (job->field.part_count == 0) { return 1; }
  narsil_paged_graph_part *parts = copy_region(job, job->field.parts, job->field.part_count, sizeof *parts);
  if (parts == NULL) { return 0; }
  job->field.parts = parts;
  for (size_t at = 0; at < job->field.part_count; at++) {
    narsil_paged_graph_part *part = &parts[at];
    part->levels = copy_region(job, part->levels, part->level_count, sizeof *part->levels);
    part->node_offsets = copy_region(job, part->node_offsets, part->offset_count, sizeof *part->node_offsets);
    if (part->levels == NULL || part->node_offsets == NULL || !copy_paged_section(job, &part->neighbours)) { return 0; }
  }
  return 1;
}

narsil_status copy_paged_inputs(paged_async_job *job, const narsil_paged_vector_field *field,
                                const narsil_paged_vector_request *request) {
  job->field = *field;
  job->request = *request;
  if (!copy_files(job) || !copy_parts(job)) { return NARSIL_OUT_OF_MEMORY; }
  if (field->centroid != NULL) {
    job->field.centroid = copy_region(job, field->centroid, field->centroid_count, sizeof *field->centroid);
    if (job->field.centroid == NULL) { return NARSIL_OUT_OF_MEMORY; }
  }
  job->request.query = copy_region(job, request->query, request->query_count, sizeof *request->query);
  if (job->request.query == NULL) { return NARSIL_OUT_OF_MEMORY; }
  if (request->accepted != NULL) {
    job->request.accepted = copy_region(job, request->accepted, request->accepted_words, sizeof *request->accepted);
    if (job->request.accepted == NULL) { return NARSIL_OUT_OF_MEMORY; }
  }
  if (request->excluded != NULL) {
    job->request.excluded = copy_region(job, request->excluded, request->excluded_words, sizeof *request->excluded);
    if (job->request.excluded == NULL) { return NARSIL_OUT_OF_MEMORY; }
  }
  return NARSIL_OK;
}
