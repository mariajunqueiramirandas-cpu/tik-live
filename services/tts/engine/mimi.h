// Mimi's decoder: latents (12.5 Hz) -> 24 kHz audio, in chunks, with streaming state carried
// between chunks so the output is the same as decoding the whole sequence at once.
#pragma once

#include <algorithm>
#include <array>
#include <memory>

#include "model.h"
#include "pool.h"

namespace pk {

struct MimiState {
  int pos = 0;            // transformer positions decoded so far
  Buf<float> up_prev;     // last projected latent [m_dim]
  Buf<float> kp, vp;      // attention keys and values per layer and head, see Mimi::attend
  int kbase = 0;          // position of their first entry
  Buf<uint8_t> hist;      // every conv's left context, see Mimi::stages_
};

class Mimi {
 public:
  Mimi(const Config& c, const MimiWeights& w, const Kernels& k, Pool& pool, int max_chunk, int max_frames);
  // Another decoder on its own pool, sharing lead's derived weights and mode: same output, and any
  // instance can continue any MimiState.
  Mimi(const Mimi& lead, Pool& pool);
  int max_chunk() const { return max_chunk_; }
  const char* mode() const {
    return amx_ ? "bf16" : d_->mode == Mode::kF32 ? "f32" : d_->mode == Mode::kQ12 ? "q12" : "q8";
  }
  void reset(MimiState& s) const;
  // n latents [n][ldim] (flow LM space) -> n * frame_samples floats
  void decode(MimiState& s, const float* lat, int n, float* audio);

 private:
  // A conv's input: `hist` rows of history, then the chunk's rows. bfloat16 when an AMX GEMM
  // reads it, else float32.
  struct Stage {
    int hist, ch, esz;
    size_t off;  // where its history lives in MimiState::hist, in bytes
    Buf<uint8_t> buf;
    float* f() { return reinterpret_cast<float*>(buf.p); }
    uint16_t* h() { return reinterpret_cast<uint16_t*>(buf.p); }
  };
  // With AMX every matrix of the decoder runs in bfloat16, converted from float32 at startup.
  struct Bf16 {
    std::vector<std::array<BW, 4>> layers;  // qkv, o, ff1, ff2
    BW c0;
    std::vector<BW> ups;
    std::vector<std::vector<BW>> res;
  };
  enum class Mode { kF32, kQ12, kQ8 };  // the transformer's and c0's matrices without AMX
  // int8 copies q8_fast reads: the file's, or 7-bit ones built here (Kernels::fast_wbits)
  struct Fast {
    std::vector<std::array<QW, 4>> layers;
    QW c0;
  };
  // built once by the lead instance
  struct Derived {
    Mode mode = Mode::kF32;
    Bf16 bf;
    Fast fast;
    Buf<float> cos, sin;  // rotary tables
    std::vector<Buf<uint8_t>> store;  // bf's and fast's matrices
  };
  template <class T>
  T* own(size_t n) {
    d_->store.emplace_back(n * sizeof(T));
    return reinterpret_cast<T*>(d_->store.back().p);
  }
  void init_scratch();
  BW to_bf16(const PW& w);
  QW to_q7(const PW& w);
  void choose_mode(bool f32, bool q12, bool q8);
  void gemm(const PW& w, const float* A, int lda, int M, float* C, int ldc, int flags);
  void qgemm(const Q8& q, const QW& w, const float* A, int lda, int M, float* C, int ldc, bool accumulate);
  void dense(const Linear& w, const QW& fast, const float* A, int lda, int M, float* C, int ldc, bool accumulate);
  void gemm(const BW& w, const uint16_t* A, int lda, int M, float* C, int ldc, bool accumulate);
  // matrix i (qkv, o, ff1, ff2) of transformer layer l on P rows of x
  void linear(int l, int i, const float* x, int P, float* C, int ldc, bool accumulate);
  void transformer(MimiState& s, float* x, int P);
  void attend(MimiState& s, int l, int h, int P);  // one head of layer l, from qkv_ into att_
  // entries the attention history drops after a chunk of P: whole panels the next window won't reach
  int kept(const MimiState& s, int P) const { return (std::max(0, s.pos + P - (W_ - 1)) - s.kbase) & ~31; }
  static constexpr int kQB = 32;  // queries per attention block
  // n floats -> dst as float32 or bfloat16 (esz 4 or 2), through ELU if asked; dst may be src
  void convert(const float* src, size_t n, uint8_t* dst, int esz, bool elu);
  void stage_in(MimiState& s, Stage& st, const float* src, int rows, bool elu);
  void stage_save(MimiState& s, Stage& st, int rows) const;

  const Config& c_;
  const MimiWeights& w_;
  const Kernels& k_;
  Pool& pool_;
  const bool amx_;
  int max_chunk_, max_pos_, W_;
  int cap_ = 0, smax_ = 0;  // attention entries per head; score columns per query block
  std::shared_ptr<Derived> d_;
  // scratch
  Buf<float> lat_, x_, h_, qkv_, att_, ff_, s_;
  Buf<uint16_t> xb_;           // a transformer matrix's input in bfloat16
  std::vector<Buf<float>> y_;  // per SEANet stage output
  Buf<float> rh_;              // residual hidden
  Buf<uint16_t> rhb_;          // its ELU in bfloat16
  Buf<uint8_t> qa_;            // quantized activations, one slot per job
  size_t qa_slot_ = 0;
  int qa_rows_ = 0;            // rows per job
  std::vector<Stage> stages_;  // c0, then per ratio: up, residual convs; last: output conv
  size_t hist_size_ = 0;
};

}  // namespace pk
