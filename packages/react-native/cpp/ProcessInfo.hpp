#pragma once

#include <string>

namespace margelo::nitro::narsil {

double residentBytesOfThisProcess();
double availableBytesForThisProcess();
std::string privateStorageDirectory();

}
