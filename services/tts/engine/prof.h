// Section timers for benchmarking (PK_PROFILE=1); a branch when off.
#pragma once

#include <chrono>

namespace pk {

bool prof_on();
void prof_add(const char* name, double seconds);
void prof_dump();

struct ProfScope {
  const char* name;
  std::chrono::steady_clock::time_point t0;
  explicit ProfScope(const char* n) : name(prof_on() ? n : nullptr) {
    if (name) t0 = std::chrono::steady_clock::now();
  }
  ~ProfScope() {
    if (name) prof_add(name, std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
  }
};

}  // namespace pk

#define PK_CAT2(a, b) a##b
#define PK_CAT(a, b) PK_CAT2(a, b)
#define PROF(name) ::pk::ProfScope PK_CAT(prof_, __LINE__)(name)
