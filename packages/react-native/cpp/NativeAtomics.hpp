#pragma once

#include <NitroModules/ArrayBuffer.hpp>
#include <memory>

namespace margelo::nitro::narsil {

double atomicOnHostMemory(double operation, double elementKind, const std::shared_ptr<ArrayBuffer>& buffer,
                          double byteIndex, double value, double replacement);

}
