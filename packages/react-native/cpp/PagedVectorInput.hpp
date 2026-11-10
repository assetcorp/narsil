#pragma once

#include "PagedInput.hpp"
#include "narsil_paged_vectors.h"

#include <memory>
#include <vector>

namespace margelo::nitro::narsil {

class PagedVectorInput {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value);
  narsil_paged_vector_field read(jsi::Runtime& runtime);
  std::vector<PagedFile> filesHeld() const;
private:
  struct File {
    narsil_paged_vector_file value{};
    narsil_page_section record{};
    PagedSectionInput vectors;
    PagedSectionInput records;
    TypedElements dead{1};
    bool hasDead = false;
    bool hasRecords = false;
  };
  struct Part {
    narsil_paged_graph_part value{};
    PagedSectionInput neighbours;
    TypedElements regions{2};
  };
  narsil_paged_vector_field _field{};
  TypedElements _centroid{1};
  std::vector<std::unique_ptr<File>> _files;
  std::vector<std::unique_ptr<Part>> _parts;
  std::vector<narsil_paged_vector_file> _fileValues;
  std::vector<narsil_paged_graph_part> _partValues;
};

class PagedQueryInput {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value);
  narsil_paged_vector_request read(jsi::Runtime& runtime);
private:
  narsil_paged_vector_request _request{};
  TypedElements _regions{3};
  bool _accepted = false;
  bool _excluded = false;
};

}
