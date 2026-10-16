// Pocket TTS inference engine: shared types. See ../README.md for the design.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>

namespace pk {

constexpr int kMaxRatios = 4;

struct Config {
  int d_model, heads, layers, ff, ldim, vocab, flow_dim, flow_depth;
  int m_dim, m_heads, m_layers, m_ff, m_context, n_filters, n_residual;
  int kernel, res_kernel, last_kernel, upsample, sample_rate;
  int n_ratios, ratios[kMaxRatios];
  float max_period, m_max_period;

  int head_dim() const { return d_model / heads; }
  int m_head_dim() const { return m_dim / m_heads; }
  int hop() const {  // audio samples per Mimi transformer position
    int h = 1;
    for (int i = 0; i < n_ratios; i++) h *= ratios[i];
    return h;
  }
  int frame_samples() const { return upsample * hop(); }
};

// int8 linear layer, y = x @ W.T: weights in VNNI blocks [N/16][K/4][16][4], one scale per
// output row, the row sums of the int8 weights (to undo the activations' zero point), bias.
// r: when set, the weights were rotated at packing (W D H / K, D = diag(r), H a Hadamard matrix),
// and the activations get x D H as they are quantized, so both lose their outliers (QuaRot).
struct QW {
  int N = 0, K = 0;
  const int8_t* q = nullptr;
  const float* s = nullptr;
  const int32_t* z = nullptr;
  const float* b = nullptr;
  const float* r = nullptr;
};

constexpr int kMaxRotK = 4096;

// int4 linear layer, always on a rotated input (r): W[n][k] = s[n] * (u - 8), u the 4-bit codes.
// [N/16][K/8][64]: per 8 k, 16 columns x 4 bytes, each byte holding k (low nibble) and k + 4 (high),
// so one 64-byte load feeds a vpdpbusd per nibble, or two vpmaddubsw per nibble on AVX2.
struct QW4 {
  int N = 0, K = 0;
  const uint8_t* q = nullptr;
  const float* s = nullptr;
  const float* b = nullptr;
  const float* r = nullptr;
};

// float32 GEMM right-hand side [K][N] in panels of 32 columns: [N/32][K][32].
struct PW {
  int N = 0, K = 0;
  const float* p = nullptr;
  const float* b = nullptr;
};

// bfloat16 GEMM right-hand side for AMX: [N/16][K/2][16][2], so one 64-byte tile row holds a pair of
// k for 16 columns.
struct BW {
  int N = 0, K = 0;
  const uint16_t* w = nullptr;
  const float* b = nullptr;
};

inline uint16_t bf16_rne(float f) {
  uint32_t u;
  std::memcpy(&u, &f, 4);
  if ((u & 0x7F800000u) == 0x7F800000u) return uint16_t(u >> 16 | ((u & 0xFFFF) ? 0x40 : 0));  // inf, nan
  return uint16_t((u + 0x7FFF + ((u >> 16) & 1)) >> 16);
}

// A linear layer as int4, int8, float32 or int8 and float32 (the decoder's: AMX converts the float32 to
// bfloat16).
struct Linear {
  bool q4 = false, q8 = false;
  QW4 w4;
  QW q;
  PW f;
  int N() const { return q4 ? w4.N : q8 ? q.N : f.N; }
  int K() const { return q4 ? w4.K : q8 ? q.K : f.K; }
  const float* bias() const { return q4 ? w4.b : q8 ? q.b : f.b; }
};

void* aligned_alloc64(size_t bytes);
void aligned_free(void* p);

template <class T>
struct Buf {
  T* p = nullptr;
  size_t n = 0;
  Buf() = default;
  explicit Buf(size_t count) { resize(count); }
  Buf(const Buf&) = delete;
  Buf& operator=(const Buf&) = delete;
  Buf(Buf&& o) noexcept : p(o.p), n(o.n) { o.p = nullptr, o.n = 0; }
  Buf& operator=(Buf&& o) noexcept {
    std::swap(p, o.p);
    std::swap(n, o.n);
    return *this;
  }
  ~Buf() { aligned_free(p); }
  void resize(size_t count) {  // contents are not kept
    if (count <= n) return;
    aligned_free(p);
    p = static_cast<T*>(aligned_alloc64(count * sizeof(T)));
    n = count;
  }
  void zero() { std::memset(p, 0, n * sizeof(T)); }
  T* data() { return p; }
  T& operator[](size_t i) { return p[i]; }
};

// int8 weights times quantized activations: quantize M rows of K floats (row stride ldx) into qa,
// rotating each first when rot is set (QW::r), then y[m][n] (+)= dequant(qa[m] . W[n]) + bias[n]
// for n in [n0, n1) (multiples of 16).
struct Q8 {
  size_t (*qact_bytes)(int M, int K);
  void (*quantize)(const float* x, int ldx, int M, int K, const float* rot, void* qa);
  void (*gemm)(const void* qa, int M, const QW& w, int n0, int n1, float* y, int ldy, bool accumulate);
};

// int4 weights times int8 activations (symmetric per row, after the rotation).
struct Q4 {
  size_t (*qact_bytes)(int M, int K);
  void (*quantize)(const float* x, int ldx, int M, int K, const float* rot, void* qa);
  void (*gemm)(const void* qa, int M, const QW4& w, int n0, int n1, float* y, int ldy, bool accumulate);
};

enum GemmFlags { kAccumulate = 1, kElu = 2 };

// Kernels, one table per instruction set, picked at startup from cpuid.
struct Kernels {
  const char* name;
  // 12-bit activations, so their error is far below the weights': the speech model, on every ISA
  Q8 q8;
  // for the decoder's compute-bound rows: uint8 activations, VNNI or vpmaddubsw
  Q8 q8_fast;
  int fast_wbits;  // the weights q8_fast takes: the file's 8-bit ones, or 7-bit (|w| <= 63)
  Q4 q4;           // the speech model's int4 matrices
  // C[m][n] (+)= bias[n] + sum_k A[m*lda + k] * B[k][n] for n in [n0, n1) (multiples of 32);
  // flags: kAccumulate, kElu (on the result as it is stored)
  void (*f32_gemm)(const float* A, int lda, int M, int K, const float* panels, const float* bias,
                   int n0, int n1, float* C, int ldc, int flags);
  // One query against n float16 keys/values of one head. K: blocks of 16 positions [n/16][D][16],
  // V: rows [n][D]. q is already rotated and scaled. scores: scratch of n floats.
  void (*attn_f16)(const float* q, const uint16_t* K, const uint16_t* V, int n, int D, float* out, float* scores);
  void (*layernorm)(const float* x, int n, const float* w, const float* b, float eps, float* y);
  void (*gelu_tanh)(float* x, int n);
  void (*silu)(float* x, int n);
  void (*elu)(const float* x, int n, float* y);
  // in place: x <- exp(x - max(x)), returns the sum
  float (*softmax_exp)(float* x, int n);
  void (*f32_to_f16)(const float* x, int n, uint16_t* y);
  float (*dot)(const float* a, const float* b, int n);
  // y = H (signs * x), H the Sylvester Hadamard matrix of size n (a power of two >= 16), unnormalized
  void (*hadamard)(const float* x, int n, const float* signs, float* y);
  // AMX only, nullptr elsewhere. C[m][n] (+)= bias[n] + sum_k A[m*lda + k] * W[n][k], bf16 inputs;
  // M a multiple of 16, K of 32, n0 and n1 of 16.
  void (*bf16_gemm)(const uint16_t* A, int lda, int M, int K, const BW& w, int n0, int n1, float* C, int ldc,
                    bool accumulate);
  void (*to_bf16)(const float* x, int n, uint16_t* y);
  void (*elu_bf16)(const float* x, int n, uint16_t* y);
};

const Kernels& kernels_avx512();
const Kernels& kernels_avx2();
const Kernels& kernels_avxvnni();  // the AVX2 kernels built with AVX-VNNI
const Kernels& kernels_amx();
bool amx_enable();  // asks Linux for the AMX tile state; false if refused
const Kernels& pick_kernels(const char* force);  // force: "amx", "avx512", "avxvnni", "avx2" or nullptr

}  // namespace pk
