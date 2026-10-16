// Scheduling: one thread runs the speech model, one runs the audio decoder, concurrently.
//
// The model thread batches every live sequence into one forward per step, so each weight is read
// once per step however many voice notes are in flight. A new sequence joins with its text rows,
// then its first (BOS) row, in the same forward as the others' decode rows. Latents go to the
// decoder thread, which turns them into audio chunk by chunk while the model keeps generating.
#include <cpuid.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <thread>
#include <unordered_map>

#include "lm.h"
#include "mimi.h"
#include "pocket.h"
#include "prof.h"

namespace pk {

namespace {

constexpr float kEosThreshold = -4.0f;
constexpr int kMinFramesBeforeEos = 6;

int max_frames_for(int n_tokens, double frame_rate) {
  return int(std::ceil((n_tokens / 3.0 + 2.0) * frame_rate));
}

struct Rng {  // xoshiro256**, seeded with splitmix64
  uint64_t s[4];
  explicit Rng(uint64_t seed) {
    for (auto& x : s) {
      seed += 0x9E3779B97F4A7C15ull;
      uint64_t z = seed;
      z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
      z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
      x = z ^ (z >> 31);
    }
  }
  static uint64_t rotl(uint64_t x, int k) { return (x << k) | (x >> (64 - k)); }
  uint64_t next() {
    const uint64_t r = rotl(s[1] * 5, 7) * 9, t = s[1] << 17;
    s[2] ^= s[0], s[3] ^= s[1], s[1] ^= s[2], s[0] ^= s[3], s[2] ^= t, s[3] = rotl(s[3], 45);
    return r;
  }
  double uniform() { return (double(next() >> 11) + 1.0) * 0x1.0p-53; }  // (0, 1]
  void normals(float* out, int n, float std) {
    for (int i = 0; i < n; i += 2) {
      const double r = std::sqrt(-2.0 * std::log(uniform())), a = 6.283185307179586 * uniform();
      out[i] = float(r * std::cos(a)) * std;
      if (i + 1 < n) out[i + 1] = float(r * std::sin(a)) * std;
    }
  }
};

}  // namespace

struct Seq {
  int64_t id;
  std::vector<int32_t> tokens;
  int voice, fae, max_frames;
  float std;
  Rng rng;
  KVCache kv;
  int step = 0, eos_step = -1;
  bool prefilled = false;
  std::vector<float> prev;  // last latent, the next step's input
  // shared with the decoder thread and readers, under Engine::mu
  std::vector<float> latents;
  int decoded = 0;
  bool lm_done = false, finished = false, released = false, failed = false;
  bool busy = false;  // a thread is decoding its next chunk
  MimiState ms;
  bool mimi_started = false;
  std::vector<int16_t> audio;
  size_t read = 0;
  std::condition_variable cv;
  Seq(int64_t i, uint64_t seed) : id(i), rng(seed) {}
};

const Kernels& pick_kernels(const char* force) {
  __builtin_cpu_init();
  const bool avx512 = __builtin_cpu_supports("avx512f") && __builtin_cpu_supports("avx512bw") &&
                      __builtin_cpu_supports("avx512vl") && __builtin_cpu_supports("avx512dq") &&
                      __builtin_cpu_supports("avx512vnni");
  const bool avx2 = __builtin_cpu_supports("avx2") && __builtin_cpu_supports("fma") && __builtin_cpu_supports("f16c");
  unsigned a, b, c, d, a1 = 0, b1, c1, d1;
  const bool leaf7 = __get_cpuid_count(7, 0, &a, &b, &c, &d) && __get_cpuid_count(7, 1, &a1, &b1, &c1, &d1);
  // AMX-BF16 (edx 22), AMX-TILE (edx 24), AVX512-BF16 (leaf 7.1 eax 5)
  const bool amx_cpu = avx512 && leaf7 && (d >> 22 & 1) && (d >> 24 & 1) && (a1 >> 5 & 1);
  const bool avxvnni = avx2 && leaf7 && (a1 >> 4 & 1);  // leaf 7.1 eax 4
  const std::string f = force ? force : "";
  if (f == "amx") {
    if (!amx_cpu) throw std::runtime_error("this CPU lacks AMX-BF16");
    if (!amx_enable()) throw std::runtime_error("the kernel refused AMX tile state");
    return kernels_amx();
  }
  if (f == "avx512") {
    if (!avx512) throw std::runtime_error("this CPU lacks AVX-512 VNNI");
    return kernels_avx512();
  }
  if (f == "avxvnni") {
    if (!avxvnni) throw std::runtime_error("this CPU lacks AVX-VNNI");
    return kernels_avxvnni();
  }
  if (f == "avx2") {
    if (!avx2) throw std::runtime_error("this CPU lacks AVX2/FMA/F16C");
    return kernels_avx2();
  }
  if (!f.empty()) throw std::runtime_error("unknown isa " + f);
  if (amx_cpu && amx_enable()) return kernels_amx();
  if (avx512) return kernels_avx512();
  if (avxvnni) return kernels_avxvnni();
  if (avx2) return kernels_avx2();
  throw std::runtime_error("needs a CPU with AVX2, FMA and F16C");
}

class Engine {
 public:
  Engine(const char* path, const pk_options& o)
      : file_(path),
        k_(pick_kernels(o.isa)),
        lw_(load_lm(file_, o.speech_bits == 4)),
        mw_(load_mimi(file_)),
        opt_(o),
        max_frames_(max_frames_for(o.max_tokens, double(file_.cfg.sample_rate) / file_.cfg.frame_samples())),
        lm_pool_(o.lm_threads),
        mimi_pool_(o.mimi_threads),
        lm_(file_.cfg, lw_, k_, lm_pool_, rows_budget(o), voice_max() + o.max_tokens + max_frames_ + 16),
        mimi_(file_.cfg, mw_, k_, mimi_pool_, o.chunk, max_frames_) {
    if (lw_.voices.empty()) throw std::runtime_error("model file has no voices");
    if (o.max_batch > 0) {
      mimi_dec_ = std::make_unique<Decoders>(mimi_, mimi_pool_, true);
      lm_dec_ = std::make_unique<Decoders>(mimi_, lm_pool_, false);
      lm_thread_ = std::thread([this] { lm_loop(); });
      mimi_thread_ = std::thread([this] { mimi_loop(); });
    }
  }

  ~Engine() {
    {
      std::lock_guard<std::mutex> g(mu_);
      stop_ = true;
    }
    lm_cv_.notify_all();
    mimi_cv_.notify_all();
    if (lm_thread_.joinable()) lm_thread_.join();
    if (mimi_thread_.joinable()) mimi_thread_.join();
  }

  const Kernels& kernels() const { return k_; }
  const char* decoder_mode() const { return mimi_.mode(); }
  int speech_bits() const { return lw_.layers[0].qkv.q4 ? 4 : 8; }
  const Config& cfg() const { return file_.cfg; }
  const LMWeights& lw() const { return lw_; }
  int max_tokens() const { return opt_.max_tokens; }

  int64_t submit(const int32_t* tok, int n, int voice, float temp, int fae, uint64_t seed) {
    if (opt_.max_batch <= 0 || n < 1 || n > opt_.max_tokens || voice < 0 || voice >= int(lw_.voices.size()) ||
        !(temp >= 0) || fae < 0 || fae > 50)
      return -1;
    std::lock_guard<std::mutex> g(mu_);
    auto s = std::make_shared<Seq>(++next_id_, seed);
    s->tokens.assign(tok, tok + n);
    s->voice = voice, s->fae = fae, s->std = std::sqrt(temp);
    s->max_frames = max_frames_for(n, double(cfg().sample_rate) / cfg().frame_samples());
    seqs_[s->id] = s;
    pending_.push_back(s);
    lm_cv_.notify_one();
    return s->id;
  }

  int read(int64_t id, int16_t* out, int cap, int timeout_ms) {
    std::unique_lock<std::mutex> g(mu_);
    auto it = seqs_.find(id);
    if (it == seqs_.end()) return -2;
    auto s = it->second;
    auto ready = [&] { return s->failed || s->read < s->audio.size() || s->finished || stop_; };
    if (!s->cv.wait_for(g, std::chrono::milliseconds(timeout_ms), ready)) return 0;
    if (s->failed) return -2;
    if (s->read < s->audio.size()) {
      const size_t n = std::min(size_t(cap), s->audio.size() - s->read);
      std::memcpy(out, s->audio.data() + s->read, n * 2);
      s->read += n;
      return int(n);
    }
    return s->finished ? -1 : 0;
  }

  void release(int64_t id) {
    std::lock_guard<std::mutex> g(mu_);
    auto it = seqs_.find(id);
    if (it == seqs_.end()) return;
    it->second->released = true;
    seqs_.erase(it);
  }

  void stats(int* queued, int* active, int* decoding) {
    std::lock_guard<std::mutex> g(mu_);
    *queued = int(pending_.size());
    *active = int(active_.size());
    int d = 0;
    for (auto& kv : seqs_) d += !kv.second->finished && !kv.second->failed;
    *decoding = d;
  }

  int debug_generate(int voice, const int32_t* tok, int n, const float* noise, int max_steps, int fae, float* lat,
                     float* eos, float* hidden, const float* teacher) {
    std::lock_guard<std::mutex> g(debug_mu_);
    const Config& c = cfg();
    KVCache kv;
    lm_.start(kv, voice, n + max_steps + 1);
    std::vector<Row> rows;
    std::vector<float> x(size_t(n + 1) * c.d_model), cbuf(c.d_model);
    lm_.embed_tokens(tok, n, x.data());
    for (int i = 0; i < n; i++) rows.push_back({&kv, kv.len + i});
    const float* prev = nullptr;
    lm_.embed_latents(1, &prev, x.data() + size_t(n) * c.d_model);
    rows.push_back({&kv, kv.len + n});
    int out_row = n, emitted = 0, eos_step = -1;
    std::vector<float> latent(c.ldim);
    for (int i = 0; i < max_steps; i++) {
      lm_.forward(int(rows.size()), rows.data(), x.data(), &out_row, 1, cbuf.data());
      kv.len = rows.back().pos + 1;
      if (hidden) std::memcpy(hidden + size_t(i) * c.d_model, cbuf.data(), size_t(c.d_model) * 4);
      float e;
      lm_.head(1, cbuf.data(), noise + size_t(i) * c.ldim, latent.data(), &e);
      eos[i] = e;
      if (e > kEosThreshold && eos_step < 0 && i >= kMinFramesBeforeEos) eos_step = i;
      if (eos_step >= 0 && i >= eos_step + fae && !teacher) break;
      std::memcpy(lat + size_t(emitted++) * c.ldim, latent.data(), size_t(c.ldim) * 4);
      const float* p = teacher ? teacher + size_t(i) * c.ldim : latent.data();
      lm_.embed_latents(1, &p, x.data());
      rows.assign(1, Row{&kv, kv.len});
      out_row = 0;
    }
    return emitted;
  }

  int debug_decode(const float* lat, int n, int chunk, float* audio) {
    std::lock_guard<std::mutex> g(debug_mu_);
    MimiState ms;
    mimi_.reset(ms);
    const int fs = cfg().frame_samples();
    for (int i = 0; i < n; i += chunk) {
      const int m = std::min(chunk, n - i);
      mimi_.decode(ms, lat + size_t(i) * cfg().ldim, m, audio + size_t(i) * fs);
    }
    return n * fs;
  }

 private:
  static int rows_budget(const pk_options& o) { return std::max(1, o.max_batch) + 2 * (o.max_tokens + 1); }
  int voice_max() const {
    int m = 0;
    for (auto& v : lw_.voices) m = std::max(m, v.len);
    return m;
  }

  void fail(const std::shared_ptr<Seq>& s) {
    s->failed = true;
    s->lm_done = true;
    s->cv.notify_all();
  }

  void lm_loop() {
    const Config& c = cfg();
    const int D = c.d_model, L = c.ldim, budget = rows_budget(opt_);
    std::vector<std::shared_ptr<Seq>> batch;
    std::vector<Row> rows;
    std::vector<int> outs;
    std::vector<float> x(size_t(budget) * D), cbuf(size_t(budget) * D), xin, noise, lat, eos;
    std::vector<const float*> prevs;
    std::vector<std::shared_ptr<Seq>> live, dead;
    std::vector<DecodeJob> jobs(lm_dec_->width());
    for (;;) {
      int k = 0;
      {
        std::unique_lock<std::mutex> g(mu_);
        lm_cv_.wait(g, [&] {
          return stop_ || !pending_.empty() || !active_.empty() || (k = claim(jobs, lm_dec_->width())) > 0;
        });
        if (stop_) return;
        if (!k) {
          active_.erase(std::remove_if(active_.begin(), active_.end(), [](auto& s) { return s->released; }),
                        active_.end());
          int rows_used = int(active_.size());
          while (!pending_.empty() && int(active_.size()) < opt_.max_batch) {
            auto& s = pending_.front();
            if (s->released) {
              pending_.pop_front();
              continue;
            }
            const int need = int(s->tokens.size()) + 1;
            if (rows_used + need > budget) break;
            rows_used += need;
            active_.push_back(s);
            pending_.pop_front();
          }
          batch = active_;
        }
      }
      if (k) {  // nothing to step: decode a chunk, then look again
        decode(*lm_dec_, jobs, k);
        std::lock_guard<std::mutex> g(mu_);
        deliver(jobs, k);
        continue;
      }
      if (batch.empty()) continue;
      // rows: per sequence, its text rows (first step only), then its decode row
      rows.clear(), outs.clear(), prevs.clear(), live.clear(), dead.clear();
      for (auto& s : batch) {
        if (!s->prefilled) {
          try {
            lm_.start(s->kv, s->voice, int(s->tokens.size()) + s->max_frames + 1);
          } catch (const std::exception&) {
            dead.push_back(s);
            continue;
          }
          lm_.embed_tokens(s->tokens.data(), int(s->tokens.size()), x.data() + rows.size() * D);
          for (size_t i = 0; i < s->tokens.size(); i++) rows.push_back({&s->kv, s->kv.len + int(i)});
        }
        outs.push_back(int(rows.size()));
        const int pos = s->prefilled ? s->kv.len : s->kv.len + int(s->tokens.size());
        rows.push_back({&s->kv, pos});
        prevs.push_back(s->prev.empty() ? nullptr : s->prev.data());
        live.push_back(s);
      }
      if (!dead.empty()) {
        std::lock_guard<std::mutex> g(mu_);
        for (auto& s : dead) fail(s);
        active_.erase(std::remove_if(active_.begin(), active_.end(), [](auto& s) { return s->failed; }), active_.end());
      }
      const int B = int(outs.size());
      if (!B) continue;
      // decode rows take the latent projection; text rows already hold their embeddings
      xin.resize(size_t(B) * D);
      lm_.embed_latents(B, prevs.data(), xin.data());
      for (int b = 0; b < B; b++) std::memcpy(x.data() + size_t(outs[b]) * D, xin.data() + size_t(b) * D, size_t(D) * 4);
      lm_.forward(int(rows.size()), rows.data(), x.data(), outs.data(), B, cbuf.data());
      noise.resize(size_t(B) * L), lat.resize(size_t(B) * L), eos.resize(B);
      for (int b = 0; b < B; b++) live[b]->rng.normals(noise.data() + size_t(b) * L, L, live[b]->std);
      lm_.head(B, cbuf.data(), noise.data(), lat.data(), eos.data());
      std::lock_guard<std::mutex> g(mu_);
      for (int i = 0; i < B; i++) {
        Seq& s = *live[i];
        s.kv.len = rows[outs[i]].pos + 1;
        s.prefilled = true;
        const float* l = lat.data() + size_t(i) * L;
        const int st = s.step;
        if (eos[i] > kEosThreshold && s.eos_step < 0 && st >= kMinFramesBeforeEos) s.eos_step = st;
        bool emit = !(s.eos_step >= 0 && st >= s.eos_step + s.fae);
        if (emit) {
          s.latents.insert(s.latents.end(), l, l + L);
          s.prev.assign(l, l + L);
          s.step++;
        }
        if (!emit || (s.eos_step >= 0 && s.step >= s.eos_step + s.fae) || s.step >= s.max_frames) s.lm_done = true;
      }
      active_.erase(std::remove_if(active_.begin(), active_.end(), [](auto& s) { return s->lm_done || s->released; }),
                    active_.end());
      mimi_cv_.notify_one();
    }
  }

  struct DecodeJob {
    std::shared_ptr<Seq> s;
    int n = 0;
    bool failed = false;
    std::vector<float> lat, audio;
  };

  // Decoders for one thread pool: a lead whose pool splits each matrix, for a single sequence, and
  // single-threaded copies sharing its weights, one per thread, for several side by side.
  struct Decoders {
    Pool& pool;
    std::unique_ptr<Mimi> own;  // the lead, unless it is mimi_ itself
    Mimi* lead;
    std::vector<std::unique_ptr<Pool>> solo_pools;
    std::vector<std::unique_ptr<Mimi>> solo;
    Decoders(Mimi& base, Pool& p, bool is_base) : pool(p) {
      if (!is_base) own = std::make_unique<Mimi>(base, p);
      lead = is_base ? &base : own.get();
      if (p.size() > 1)
        for (int i = 0; i < p.size(); i++) {
          solo_pools.push_back(std::make_unique<Pool>(1));
          solo.push_back(std::make_unique<Mimi>(base, *solo_pools.back()));
        }
    }
    int width() const { return std::max(1, int(solo.size())); }
  };

  // Under mu_: claims up to max sequences that no thread is decoding and that have enough latents
  // for a chunk (or their last ones), oldest first, and copies their latents out.
  int claim(std::vector<DecodeJob>& jobs, int max) {
    const int min_chunk = std::max(1, opt_.chunk / 2), L = cfg().ldim;
    int k = 0;
    for (auto& kv : seqs_) {
      auto& s = kv.second;
      if (s->failed || s->finished || s->busy) continue;
      const int avail = int(s->latents.size()) / L - s->decoded;
      if (avail <= 0) {
        if (s->lm_done) {  // nothing (more) to decode
          s->finished = true;
          s->cv.notify_all();
        }
        continue;
      }
      if (avail < min_chunk && !s->lm_done) continue;
      int at = k < max ? k++ : max;  // insertion by id into the first max
      while (at > 0 && jobs[at - 1].s->id > s->id) {
        if (at < max) jobs[at].s = jobs[at - 1].s, jobs[at].n = jobs[at - 1].n;
        at--;
      }
      if (at < max) jobs[at].s = s, jobs[at].n = std::min(avail, opt_.chunk);
    }
    for (int i = 0; i < k; i++) {
      Seq& s = *jobs[i].s;
      s.busy = true;
      jobs[i].lat.assign(s.latents.begin() + size_t(s.decoded) * L, s.latents.begin() + size_t(s.decoded + jobs[i].n) * L);
    }
    return k;
  }

  void decode(Decoders& d, std::vector<DecodeJob>& jobs, int k) {
    auto run = [&](Mimi& m, DecodeJob& j) {
      j.audio.resize(size_t(j.n) * cfg().frame_samples());
      j.failed = false;
      try {
        if (!j.s->mimi_started) {
          m.reset(j.s->ms);
          j.s->mimi_started = true;
        }
        m.decode(j.s->ms, j.lat.data(), j.n, j.audio.data());
      } catch (const std::exception&) {
        j.failed = true;
      }
    };
    if (k == 1)
      run(*d.lead, jobs[0]);
    else
      d.pool.run(k, [&](int i) { run(*d.solo[i], jobs[i]); });
  }

  // Under mu_: hands the audio over and frees the sequences for the next chunk.
  void deliver(std::vector<DecodeJob>& jobs, int k) {
    const int L = cfg().ldim;
    for (int i = 0; i < k; i++) {
      DecodeJob& j = jobs[i];
      Seq& s = *j.s;
      s.busy = false;
      if (j.failed) {
        fail(j.s);
      } else {
        for (float v : j.audio) {
          const float y = std::nearbyint(std::min(1.0f, std::max(-1.0f, v)) * 32767.0f);
          s.audio.push_back(int16_t(y));
        }
        s.decoded += j.n;
        if (s.lm_done && s.decoded == int(s.latents.size()) / L) s.finished = true;
        s.cv.notify_all();
      }
      j.s.reset();
    }
    mimi_cv_.notify_one();  // re-check: more may be waiting
    lm_cv_.notify_one();
  }

  // The decoder's thread. The speech model's thread decodes too whenever it has nothing to step
  // (lm_loop), so a reply's later chunks don't wait on one thread while the other idles.
  void mimi_loop() {
    std::vector<DecodeJob> jobs(mimi_dec_->width());
    for (;;) {
      int k = 0;
      {
        std::unique_lock<std::mutex> g(mu_);
        mimi_cv_.wait(g, [&] { return stop_ || (k = claim(jobs, mimi_dec_->width())) > 0; });
        if (stop_) return;
      }
      decode(*mimi_dec_, jobs, k);
      std::lock_guard<std::mutex> g(mu_);
      deliver(jobs, k);
    }
  }

  ModelFile file_;
  const Kernels& k_;
  LMWeights lw_;
  MimiWeights mw_;
  pk_options opt_;
  int max_frames_;
  Pool lm_pool_, mimi_pool_;
  LM lm_;
  Mimi mimi_;
  std::unique_ptr<Decoders> mimi_dec_, lm_dec_;
  std::mutex mu_, debug_mu_;
  std::condition_variable lm_cv_, mimi_cv_;
  std::unordered_map<int64_t, std::shared_ptr<Seq>> seqs_;
  std::deque<std::shared_ptr<Seq>> pending_;
  std::vector<std::shared_ptr<Seq>> active_;
  int64_t next_id_ = 0;
  bool stop_ = false;
  std::thread lm_thread_, mimi_thread_;
};

}  // namespace pk

struct pk_engine {
  pk::Engine e;
  std::vector<std::string> voices;
  pk_engine(const char* path, const pk_options& o) : e(path, o) {
    for (auto& v : e.lw().voices) voices.push_back(v.name);
  }
};

extern "C" {

pk_engine* pk_open(const char* model_path, const pk_options* opt, char* err, int errlen) {
  try {
    pk_options o = *opt;
    o.lm_threads = std::max(1, o.lm_threads);
    o.mimi_threads = std::max(1, o.mimi_threads);
    o.max_tokens = std::clamp(o.max_tokens, 1, 1000);
    o.chunk = std::clamp(o.chunk, 1, 64);
    o.max_batch = std::clamp(o.max_batch, 0, 256);
    if (o.speech_bits != 4 && o.speech_bits != 8) throw std::runtime_error("speech_bits must be 4 or 8");
    return new pk_engine(model_path, o);
  } catch (const std::exception& ex) {
    if (err && errlen > 0) {
      std::strncpy(err, ex.what(), size_t(errlen) - 1);
      err[errlen - 1] = 0;
    }
    return nullptr;
  }
}

void pk_close(pk_engine* e) { delete e; }
const char* pk_isa(const pk_engine* e) { return e->e.kernels().name; }
int pk_speech_bits(const pk_engine* e) { return e->e.speech_bits(); }
const char* pk_decoder_mode(const pk_engine* e) { return e->e.decoder_mode(); }
int pk_sample_rate(const pk_engine* e) { return e->e.cfg().sample_rate; }
int pk_voice_count(const pk_engine* e) { return int(e->voices.size()); }
const char* pk_voice_name(const pk_engine* e, int i) {
  return i >= 0 && i < int(e->voices.size()) ? e->voices[i].c_str() : nullptr;
}
int pk_max_tokens(const pk_engine* e) { return e->e.max_tokens(); }

int64_t pk_submit(pk_engine* e, const int32_t* tokens, int n, int voice, float temp, int frames_after_eos,
                  uint64_t seed) {
  return e->e.submit(tokens, n, voice, temp, frames_after_eos, seed);
}
int pk_read(pk_engine* e, int64_t id, int16_t* out, int cap, int timeout_ms) {
  return e->e.read(id, out, cap, timeout_ms);
}
void pk_release(pk_engine* e, int64_t id) { e->e.release(id); }
void pk_stats(pk_engine* e, int* queued, int* active, int* decoding) { e->e.stats(queued, active, decoding); }

int pk_debug_generate(pk_engine* e, int voice, const int32_t* tokens, int n, const float* noise, int max_steps,
                      int frames_after_eos, float* latents, float* eos, float* hidden, const float* teacher) {
  try {
    return e->e.debug_generate(voice, tokens, n, noise, max_steps, frames_after_eos, latents, eos, hidden, teacher);
  } catch (const std::exception&) {
    return -1;
  }
}

int pk_debug_decode(pk_engine* e, const float* latents, int n, int chunk, float* audio) {
  try {
    return e->e.debug_decode(latents, n, chunk, audio);
  } catch (const std::exception&) {
    return -1;
  }
}

void pk_profile_dump(void) { pk::prof_dump(); }

}  // extern "C"
