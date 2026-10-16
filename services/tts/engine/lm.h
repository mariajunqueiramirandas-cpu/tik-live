// FlowLM: the transformer that predicts one 80 ms latent per step, and its flow head.
#pragma once

#include <mutex>

#include "model.h"
#include "pool.h"

namespace pk {

// One sequence's keys and values, float16. K in blocks of 16 positions [L][H][cap/16][Dh][16]
// (scores for 16 keys are 64 FMAs with no horizontal sums), V in rows [L][H][cap][Dh].
struct KVCache {
  int cap = 0, len = 0;
  Buf<uint16_t> k, v;
};

// A transformer input row: which sequence it extends, at which position.
struct Row {
  KVCache* kv;
  int pos;
};

class LM {
 public:
  LM(const Config& c, const LMWeights& w, const Kernels& k, Pool& pool, int max_rows, int max_pos);

  int max_rows() const { return max_rows_; }
  int max_pos() const { return max_pos_; }
  // Fills the cache with a voice prompt (positions 0..len-1); capacity for `extra` more.
  void start(KVCache& kv, int voice, int extra);
  void embed_tokens(const int32_t* tok, int n, float* x) const;
  // x [B][D] <- input projection of latents [B][ldim] (nullptr row = BOS)
  void embed_latents(int B, const float* const* lat, float* x);
  // Runs the transformer over R rows (in place on x [R][D]) and writes the normalized output of
  // rows outs[0..n_out) to c [n_out][D]. Rows of one sequence must be consecutive, in order.
  void forward(int R, const Row* rows, float* x, const int* outs, int n_out, float* c);
  // Flow head for B rows: c [B][D], noise [B][ldim] -> latent [B][ldim], eos logit [B]
  void head(int B, const float* c, const float* noise, float* latent, float* eos);

  const Config& cfg() const { return c_; }

 private:
  void linear(const Linear& l, const float* x, int ldx, int M, float* y, int ldy, bool accumulate);
  void rope(float* v, int pos) const;
  const uint16_t* voice_template(int voice, bool keys);

  const Config& c_;
  const LMWeights& w_;
  const Kernels& k_;
  Pool& pool_;
  int max_rows_, max_pos_;
  Buf<float> cos_, sin_;
  Buf<float> h_, qkv_, att_, f_, scores_, mods_, y_, xh_, t_;
  Buf<uint8_t> qa_;
  // voice prompts laid out like a cache (built on first use)
  std::vector<Buf<uint16_t>> vk_, vv_;
  std::mutex voice_mu_;
};

}  // namespace pk
