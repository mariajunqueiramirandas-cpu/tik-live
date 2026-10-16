// Fork-join pool for splitting one matmul across cores. The caller works too; workers spin
// briefly between jobs (a step is ~40 jobs a few hundred microseconds apart), then sleep.
// Every worker checks in once per job before run() returns, so a job's state is never rewritten
// under a worker that is still reading it.
#pragma once

#include <immintrin.h>

#include <atomic>
#include <thread>
#include <vector>

namespace pk {

class Pool {
 public:
  explicit Pool(int threads) : n_(threads < 1 ? 1 : threads) {
    for (int i = 1; i < n_; i++) threads_.emplace_back([this] { loop(); });
  }
  ~Pool() {
    stop_ = true;
    gen_.fetch_add(1, std::memory_order_release);
    gen_.notify_all();
    for (auto& t : threads_) t.join();
  }
  Pool(const Pool&) = delete;
  Pool& operator=(const Pool&) = delete;

  int size() const { return n_; }

  // f(i) for i in [0, tasks), on the caller and the workers.
  template <class F>
  void run(int tasks, F&& f) {
    if (tasks <= 0) return;
    if (n_ == 1 || tasks == 1) {
      for (int i = 0; i < tasks; i++) f(i);
      return;
    }
    using Fn = std::remove_reference_t<F>;
    ctx_ = const_cast<void*>(static_cast<const void*>(&f));
    call_ = [](void* c, int i) { (*static_cast<Fn*>(c))(i); };
    tasks_ = tasks;
    next_.store(0, std::memory_order_relaxed);
    checkin_.store(0, std::memory_order_relaxed);
    gen_.fetch_add(1, std::memory_order_release);
    gen_.notify_all();
    work();
    while (checkin_.load(std::memory_order_acquire) < n_ - 1) _mm_pause();
  }

 private:
  void work() {
    for (int i; (i = next_.fetch_add(1, std::memory_order_relaxed)) < tasks_;) call_(ctx_, i);
  }

  void loop() {
    uint64_t seen = gen_.load(std::memory_order_acquire);
    for (;;) {
      uint64_t g;
      int spins = 0;
      while ((g = gen_.load(std::memory_order_acquire)) == seen) {
        if (++spins < kSpins)
          _mm_pause();
        else
          gen_.wait(seen, std::memory_order_acquire);
      }
      seen = g;
      if (stop_) return;
      work();
      checkin_.fetch_add(1, std::memory_order_acq_rel);
    }
  }

  static constexpr int kSpins = 1 << 15;  // ~1 ms of pause before sleeping
  int n_;
  std::vector<std::thread> threads_;
  std::atomic<uint64_t> gen_{0};
  std::atomic<int> next_{0}, checkin_{0};
  bool stop_ = false;
  int tasks_ = 0;
  void* ctx_ = nullptr;
  void (*call_)(void*, int) = nullptr;
};

}  // namespace pk
