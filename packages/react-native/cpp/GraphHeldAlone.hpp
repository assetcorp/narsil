#pragma once

#include <atomic>
#include <cstdint>

namespace margelo::nitro::narsil {

class GraphHeldAlone {
public:
  explicit GraphHeldAlone(int32_t* header);
  ~GraphHeldAlone();
  GraphHeldAlone(const GraphHeldAlone&) = delete;
  GraphHeldAlone& operator=(const GraphHeldAlone&) = delete;

  bool held() const { return _held; }
  void markEveryNodeLinked();
  void release();

private:
  int32_t* _header;
  bool _held;
  std::atomic<bool> _released{false};
};

}
