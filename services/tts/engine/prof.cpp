#include "prof.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <string>

namespace pk {

namespace {
std::mutex mu;
std::map<std::string, std::pair<double, long>>& table() {
  static std::map<std::string, std::pair<double, long>> t;
  return t;
}
}  // namespace

bool prof_on() {
  static const bool on = [] {
    const char* v = std::getenv("PK_PROFILE");
    return v && std::strcmp(v, "0") != 0;
  }();
  return on;
}

void prof_add(const char* name, double seconds) {
  std::lock_guard<std::mutex> g(mu);
  auto& e = table()[name];
  e.first += seconds;
  e.second++;
}

void prof_dump() {
  std::lock_guard<std::mutex> g(mu);
  double total = 0;
  for (auto& kv : table()) total += kv.second.first;
  for (auto& kv : table())
    std::fprintf(stderr, "  %-14s %9.1f ms  %8ld calls  %5.1f%%\n", kv.first.c_str(), kv.second.first * 1e3,
                 kv.second.second, 100 * kv.second.first / (total > 0 ? total : 1));
  table().clear();
}

}  // namespace pk
