// AVX-512 kernels (F, BW, VL, DQ, VNNI). Built with those flags; called only when cpuid has them.
#include <immintrin.h>

#include <cmath>

#include "internal.h"
#include "vmath512.h"

namespace pk {
namespace {

// ---- vector math --------------------------------------------------------------------------

inline float hsum(__m512 v) { return _mm512_reduce_add_ps(v); }

// ---- elementwise ----------------------------------------------------------------------------

void layernorm(const float* x, int n, const float* w, const float* b, float eps, float* y) {
  __m512 s = _mm512_setzero_ps();
  int i = 0;
  for (; i + 16 <= n; i += 16) s = _mm512_add_ps(s, _mm512_loadu_ps(x + i));
  float mean = hsum(s);
  for (; i < n; i++) mean += x[i];
  mean /= n;
  __m512 m = _mm512_set1_ps(mean), v = _mm512_setzero_ps();
  for (i = 0; i + 16 <= n; i += 16) {
    __m512 d = _mm512_sub_ps(_mm512_loadu_ps(x + i), m);
    v = _mm512_fmadd_ps(d, d, v);
  }
  float var = hsum(v);
  for (; i < n; i++) var += (x[i] - mean) * (x[i] - mean);
  var /= n;
  float inv = 1.0f / std::sqrt(var + eps);
  __m512 iv = _mm512_set1_ps(inv);
  for (i = 0; i + 16 <= n; i += 16) {
    __m512 t = _mm512_mul_ps(_mm512_sub_ps(_mm512_loadu_ps(x + i), m), iv);
    if (w) t = _mm512_fmadd_ps(t, _mm512_loadu_ps(w + i), _mm512_loadu_ps(b + i));
    _mm512_storeu_ps(y + i, t);
  }
  for (; i < n; i++) {
    float t = (x[i] - mean) * inv;
    y[i] = w ? t * w[i] + b[i] : t;
  }
}

inline __m512 gelu_ps(__m512 x) {
  // 0.5 x (1 + tanh(u)), tanh(u) = 1 - 2 / (exp(2u) + 1)
  __m512 x3 = _mm512_mul_ps(_mm512_mul_ps(x, x), x);
  __m512 u = _mm512_mul_ps(_mm512_set1_ps(0.7978845608028654f), _mm512_fmadd_ps(_mm512_set1_ps(0.044715f), x3, x));
  u = _mm512_min_ps(_mm512_max_ps(u, _mm512_set1_ps(-9.0f)), _mm512_set1_ps(9.0f));
  __m512 e = exp_ps(_mm512_add_ps(u, u));
  __m512 t = _mm512_sub_ps(_mm512_set1_ps(1.0f), _mm512_div_ps(_mm512_set1_ps(2.0f), _mm512_add_ps(e, _mm512_set1_ps(1.0f))));
  return _mm512_mul_ps(_mm512_mul_ps(_mm512_set1_ps(0.5f), x), _mm512_add_ps(t, _mm512_set1_ps(1.0f)));
}

void gelu_tanh(float* x, int n) {
  int i = 0;
  for (; i + 16 <= n; i += 16) _mm512_storeu_ps(x + i, gelu_ps(_mm512_loadu_ps(x + i)));
  if (i < n) {
    __mmask16 k = (__mmask16)((1u << (n - i)) - 1);
    _mm512_mask_storeu_ps(x + i, k, gelu_ps(_mm512_maskz_loadu_ps(k, x + i)));
  }
}

inline __m512 silu_ps(__m512 x) {
  return _mm512_div_ps(x, _mm512_add_ps(_mm512_set1_ps(1.0f), exp_ps(_mm512_sub_ps(_mm512_setzero_ps(), x))));
}

void silu(float* x, int n) {
  int i = 0;
  for (; i + 16 <= n; i += 16) _mm512_storeu_ps(x + i, silu_ps(_mm512_loadu_ps(x + i)));
  if (i < n) {
    __mmask16 k = (__mmask16)((1u << (n - i)) - 1);
    _mm512_mask_storeu_ps(x + i, k, silu_ps(_mm512_maskz_loadu_ps(k, x + i)));
  }
}

void elu(const float* x, int n, float* y) {
  int i = 0;
  for (; i + 16 <= n; i += 16) _mm512_storeu_ps(y + i, elu_ps(_mm512_loadu_ps(x + i)));
  if (i < n) {
    __mmask16 k = (__mmask16)((1u << (n - i)) - 1);
    _mm512_mask_storeu_ps(y + i, k, elu_ps(_mm512_maskz_loadu_ps(k, x + i)));
  }
}

float softmax_exp(float* x, int n) {
  __m512 mx = _mm512_set1_ps(-INFINITY);
  int i = 0;
  for (; i + 16 <= n; i += 16) mx = _mm512_max_ps(mx, _mm512_loadu_ps(x + i));
  float m = _mm512_reduce_max_ps(mx);
  for (; i < n; i++) m = x[i] > m ? x[i] : m;
  __m512 vm = _mm512_set1_ps(m), s = _mm512_setzero_ps();
  for (i = 0; i + 16 <= n; i += 16) {
    __m512 e = exp_ps(_mm512_sub_ps(_mm512_loadu_ps(x + i), vm));
    _mm512_storeu_ps(x + i, e);
    s = _mm512_add_ps(s, e);
  }
  if (i < n) {
    __mmask16 k = (__mmask16)((1u << (n - i)) - 1);
    __m512 e = exp_ps(_mm512_sub_ps(_mm512_maskz_loadu_ps(k, x + i), vm));
    e = _mm512_maskz_mov_ps(k, e);
    _mm512_mask_storeu_ps(x + i, k, e);
    s = _mm512_add_ps(s, e);
  }
  return hsum(s);
}

void f32_to_f16(const float* x, int n, uint16_t* y) {
  int i = 0;
  for (; i + 16 <= n; i += 16)
    _mm256_storeu_si256((__m256i*)(y + i), _mm512_cvtps_ph(_mm512_loadu_ps(x + i), _MM_FROUND_TO_NEAREST_INT));
  for (; i < n; i++) y[i] = _cvtss_sh(x[i], _MM_FROUND_TO_NEAREST_INT);
}

// y = H (signs * x), H the n x n Sylvester Hadamard matrix (unnormalized), n a power of two >= 16.
void hadamard(const float* x, int n, const float* signs, float* y) {
  const __m512 s1 = _mm512_setr_ps(1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1);
  const __m512 s2 = _mm512_setr_ps(1, 1, -1, -1, 1, 1, -1, -1, 1, 1, -1, -1, 1, 1, -1, -1);
  const __m512 s4 = _mm512_setr_ps(1, 1, 1, 1, -1, -1, -1, -1, 1, 1, 1, 1, -1, -1, -1, -1);
  const __m512 s8 = _mm512_setr_ps(1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1, -1);
  for (int i = 0; i < n; i += 16) {
    __m512 v = _mm512_mul_ps(_mm512_loadu_ps(x + i), _mm512_loadu_ps(signs + i));
    v = _mm512_fmadd_ps(v, s1, _mm512_permute_ps(v, 0xB1));
    v = _mm512_fmadd_ps(v, s2, _mm512_permute_ps(v, 0x4E));
    v = _mm512_fmadd_ps(v, s4, _mm512_shuffle_f32x4(v, v, 0xB1));
    v = _mm512_fmadd_ps(v, s8, _mm512_shuffle_f32x4(v, v, 0x4E));
    _mm512_storeu_ps(y + i, v);
  }
  for (int h = 16; h < n; h *= 2)
    for (int i = 0; i < n; i += 2 * h)
      for (int j = i; j < i + h; j += 16) {
        const __m512 a = _mm512_loadu_ps(y + j), b = _mm512_loadu_ps(y + j + h);
        _mm512_storeu_ps(y + j, _mm512_add_ps(a, b));
        _mm512_storeu_ps(y + j + h, _mm512_sub_ps(a, b));
      }
}

float dot(const float* a, const float* b, int n) {
  __m512 s0 = _mm512_setzero_ps(), s1 = s0;
  int i = 0;
  for (; i + 32 <= n; i += 32) {
    s0 = _mm512_fmadd_ps(_mm512_loadu_ps(a + i), _mm512_loadu_ps(b + i), s0);
    s1 = _mm512_fmadd_ps(_mm512_loadu_ps(a + i + 16), _mm512_loadu_ps(b + i + 16), s1);
  }
  if (i + 16 <= n) {
    s0 = _mm512_fmadd_ps(_mm512_loadu_ps(a + i), _mm512_loadu_ps(b + i), s0);
    i += 16;
  }
  if (i < n) {
    __mmask16 k = (__mmask16)((1u << (n - i)) - 1);
    s1 = _mm512_fmadd_ps(_mm512_maskz_loadu_ps(k, a + i), _mm512_maskz_loadu_ps(k, b + i), s1);
  }
  return hsum(_mm512_add_ps(s0, s1));
}

// ---- int8 weights x uint8 activations (VNNI) -----------------------------------------------
// The decoder's compute-bound path. Activations: asymmetric uint8 per row, the range widened to
// include 0.
// qa layout: float scale[M] | int32 zero[M] | uint8 rows [M][K] (64-byte aligned)

inline size_t qa_head(int M) { return (size_t(M) * 8 + 63) & ~size_t(63); }

size_t qact_bytes(int M, int K) { return qa_head(M) + size_t(M) * K; }

void quantize(const float* x, int ldx, int M, int K, const float* rot, void* qa) {
  float* scale = (float*)qa;
  int32_t* zero = (int32_t*)((char*)qa + size_t(M) * 4);
  uint8_t* out = (uint8_t*)qa + qa_head(M);
  alignas(64) float buf[kMaxRotK];
  for (int m = 0; m < M; m++) {
    const float* r = x + size_t(m) * ldx;
    if (rot) hadamard(r, K, rot, buf), r = buf;
    __m512 lo = _mm512_setzero_ps(), hi = _mm512_setzero_ps();
    int k = 0;
    for (; k + 16 <= K; k += 16) {
      __m512 v = _mm512_loadu_ps(r + k);
      lo = _mm512_min_ps(lo, v);
      hi = _mm512_max_ps(hi, v);
    }
    float mn = _mm512_reduce_min_ps(lo), mx = _mm512_reduce_max_ps(hi);
    for (; k < K; k++) mn = r[k] < mn ? r[k] : mn, mx = r[k] > mx ? r[k] : mx;
    float s = (mx - mn) / 255.0f;
    if (!(s > 0)) s = 1.0f;
    int z = (int)std::nearbyint(-mn / s);
    z = z < 0 ? 0 : z > 255 ? 255 : z;
    scale[m] = s;
    zero[m] = z;
    __m512 inv = _mm512_set1_ps(1.0f / s);
    __m512i vz = _mm512_set1_epi32(z);
    uint8_t* o = out + size_t(m) * K;
    for (k = 0; k + 16 <= K; k += 16) {
      __m512i q = _mm512_add_epi32(_mm512_cvtps_epi32(_mm512_mul_ps(_mm512_loadu_ps(r + k), inv)), vz);
      q = _mm512_min_epi32(_mm512_max_epi32(q, _mm512_setzero_si512()), _mm512_set1_epi32(255));
      _mm_storeu_si128((__m128i*)(o + k), _mm512_cvtepi32_epi8(q));
    }
    for (; k < K; k++) {
      int q = (int)std::nearbyint(r[k] / s) + z;
      o[k] = (uint8_t)(q < 0 ? 0 : q > 255 ? 255 : q);
    }
  }
}

template <int RM, int NB>
inline void q8_tile(const uint8_t* const* rows, const int8_t* w, int K4, __m512i (&acc)[RM][NB]) {
  for (int r = 0; r < RM; r++)
    for (int j = 0; j < NB; j++) acc[r][j] = _mm512_setzero_si512();
  const size_t bstride = size_t(K4) * 64;
#pragma GCC unroll 4
  for (int kq = 0; kq < K4; kq++) {
    __m512i wv[NB];
    for (int j = 0; j < NB; j++) {
      const int8_t* p = w + j * bstride + size_t(kq) * 64;
      _mm_prefetch((const char*)p + 2048, _MM_HINT_T0);
      wv[j] = _mm512_load_si512((const void*)p);
    }
    for (int r = 0; r < RM; r++) {
      int32_t a4;
      std::memcpy(&a4, rows[r] + size_t(kq) * 4, 4);
      __m512i a = _mm512_set1_epi32(a4);
      for (int j = 0; j < NB; j++) acc[r][j] = _mm512_dpbusd_epi32(acc[r][j], a, wv[j]);
    }
  }
}

template <int RM, int NB>
void q8_block(const void* qa, int M, int m0, const QW& w, int blk0, float* y, int ldy, bool accumulate) {
  const float* scale = (const float*)qa;
  const int32_t* zero = (const int32_t*)((const char*)qa + size_t(M) * 4);
  const uint8_t* xq = (const uint8_t*)qa + qa_head(M);
  const int K4 = w.K / 4;
  const uint8_t* rows[RM];
  for (int r = 0; r < RM; r++) rows[r] = xq + size_t(m0 + r) * w.K;
  __m512i acc[RM][NB];
  q8_tile<RM, NB>(rows, w.q + size_t(blk0) * K4 * 64, K4, acc);
  for (int j = 0; j < NB; j++) {
    const int n = (blk0 + j) * 16;
    __m512i wz = _mm512_loadu_si512((const void*)(w.z + n));
    __m512 ws = _mm512_loadu_ps(w.s + n);
    __m512 bias = w.b ? _mm512_loadu_ps(w.b + n) : _mm512_setzero_ps();
    for (int r = 0; r < RM; r++) {
      __m512i v = _mm512_sub_epi32(acc[r][j], _mm512_mullo_epi32(_mm512_set1_epi32(zero[m0 + r]), wz));
      __m512 f = _mm512_mul_ps(_mm512_cvtepi32_ps(v), _mm512_mul_ps(ws, _mm512_set1_ps(scale[m0 + r])));
      f = _mm512_add_ps(f, bias);
      float* dst = y + size_t(m0 + r) * ldy + n;
      if (accumulate) f = _mm512_add_ps(f, _mm512_loadu_ps(dst));
      _mm512_storeu_ps(dst, f);
    }
  }
}

// Weights outer: a slab of NB column blocks is read from memory once and stays in cache while
// every row tile passes, so a batch costs one pass over the weights.
template <int NB>
void q8_slab(const void* qa, int M, const QW& w, int b, float* y, int ldy, bool acc) {
  int m = 0;
  for (; m + 8 <= M; m += 8) q8_block<8, NB>(qa, M, m, w, b, y, ldy, acc);
  switch (M - m) {
    case 7: q8_block<7, NB>(qa, M, m, w, b, y, ldy, acc); break;
    case 6: q8_block<6, NB>(qa, M, m, w, b, y, ldy, acc); break;
    case 5: q8_block<5, NB>(qa, M, m, w, b, y, ldy, acc); break;
    case 4: q8_block<4, NB>(qa, M, m, w, b, y, ldy, acc); break;
    case 3: q8_block<3, NB>(qa, M, m, w, b, y, ldy, acc); break;
    case 2: q8_block<2, NB>(qa, M, m, w, b, y, ldy, acc); break;
    case 1: q8_block<1, NB>(qa, M, m, w, b, y, ldy, acc); break;
  }
}

void q8_gemm(const void* qa, int M, const QW& w, int n0, int n1, float* y, int ldy, bool accumulate) {
  int b = n0 / 16;
  const int b1 = n1 / 16;
  if (M <= 2)  // four weight streams in flight for a memory-bound GEMV
    for (; b + 4 <= b1; b += 4) q8_slab<4>(qa, M, w, b, y, ldy, accumulate);
  for (; b + 3 <= b1; b += 3) q8_slab<3>(qa, M, w, b, y, ldy, accumulate);
  for (; b < b1; b++) q8_slab<1>(qa, M, w, b, y, ldy, accumulate);
}

// ---- int8 weights x 12-bit activations (vpdpwssd) ------------------------------------------
// The speech model's path: activations keep 12 bits (symmetric, per row), as on AVX2, so their
// error stays far below the weights'. It reads memory-bound weights, so the extra work of widening
// them is free at batch 1. Each 64-byte weight block (16 columns x 4 k) is widened to int16 in two
// halves; an int32 lane then sums one column's pair of k, and neighbouring lanes are added at the end.
// qa layout: float scale[M] | unused[M] | int16 rows [M][K]

constexpr float kQ12 = 2047.0f;

size_t qact_bytes12(int M, int K) { return qa_head(M) + size_t(M) * K * 2; }

void quantize12(const float* x, int ldx, int M, int K, const float* rot, void* qa) {
  float* scale = (float*)qa;
  int16_t* out = (int16_t*)((char*)qa + qa_head(M));
  alignas(64) float buf[kMaxRotK];
  for (int m = 0; m < M; m++) {
    const float* r = x + size_t(m) * ldx;
    if (rot) hadamard(r, K, rot, buf), r = buf;
    __m512 mx = _mm512_setzero_ps();
    int k = 0;
    for (; k + 16 <= K; k += 16) mx = _mm512_max_ps(mx, _mm512_abs_ps(_mm512_loadu_ps(r + k)));
    float a = _mm512_reduce_max_ps(mx);
    for (; k < K; k++) a = std::fabs(r[k]) > a ? std::fabs(r[k]) : a;
    const float s = a > 0 ? a / kQ12 : 1.0f;
    scale[m] = s;
    const __m512 inv = _mm512_set1_ps(1.0f / s);
    int16_t* o = out + size_t(m) * K;
    for (k = 0; k + 16 <= K; k += 16)
      _mm256_storeu_si256((__m256i*)(o + k),
                          _mm512_cvtsepi32_epi16(_mm512_cvtps_epi32(_mm512_mul_ps(_mm512_loadu_ps(r + k), inv))));
    for (; k < K; k++) o[k] = (int16_t)std::nearbyint(r[k] / s);
  }
}

template <int RM, int NB>
void q12_block(const void* qa, int M, int m0, const QW& w, int blk0, float* y, int ldy, bool accumulate) {
  const float* scale = (const float*)qa;
  const int16_t* xq = (const int16_t*)((const char*)qa + qa_head(M));
  const int K4 = w.K / 4;
  const size_t bstride = size_t(K4) * 64;
  const int8_t* wb = w.q + size_t(blk0) * bstride;
  const int16_t* rows[RM];
  for (int r = 0; r < RM; r++) rows[r] = xq + size_t(m0 + r) * w.K;
  __m512i acc[RM][NB][2];
  for (int r = 0; r < RM; r++)
    for (int j = 0; j < NB; j++) acc[r][j][0] = acc[r][j][1] = _mm512_setzero_si512();
#pragma GCC unroll 2
  for (int kq = 0; kq < K4; kq++) {
    __m512i lo[NB], hi[NB];
    for (int j = 0; j < NB; j++) {
      const int8_t* p = wb + j * bstride + size_t(kq) * 64;
      _mm_prefetch((const char*)p + 2048, _MM_HINT_T0);
      lo[j] = _mm512_cvtepi8_epi16(_mm256_load_si256((const __m256i*)p));
      hi[j] = _mm512_cvtepi8_epi16(_mm256_load_si256((const __m256i*)(p + 32)));
    }
    for (int r = 0; r < RM; r++) {
      long long a4;
      std::memcpy(&a4, rows[r] + size_t(kq) * 4, 8);
      const __m512i a = _mm512_set1_epi64(a4);
      for (int j = 0; j < NB; j++) {
        acc[r][j][0] = _mm512_dpwssd_epi32(acc[r][j][0], lo[j], a);
        acc[r][j][1] = _mm512_dpwssd_epi32(acc[r][j][1], hi[j], a);
      }
    }
  }
  const __m512i even = _mm512_setr_epi32(0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30);
  for (int j = 0; j < NB; j++) {
    const int n = (blk0 + j) * 16;
    const __m512 ws = _mm512_loadu_ps(w.s + n);
    const __m512 bias = w.b ? _mm512_loadu_ps(w.b + n) : _mm512_setzero_ps();
    for (int r = 0; r < RM; r++) {
      const __m512i l = _mm512_add_epi32(acc[r][j][0], _mm512_srli_epi64(acc[r][j][0], 32));
      const __m512i h = _mm512_add_epi32(acc[r][j][1], _mm512_srli_epi64(acc[r][j][1], 32));
      const __m512i sum = _mm512_permutex2var_epi32(l, even, h);
      __m512 f = _mm512_fmadd_ps(_mm512_cvtepi32_ps(sum), _mm512_mul_ps(ws, _mm512_set1_ps(scale[m0 + r])), bias);
      float* dst = y + size_t(m0 + r) * ldy + n;
      if (accumulate) f = _mm512_add_ps(f, _mm512_loadu_ps(dst));
      _mm512_storeu_ps(dst, f);
    }
  }
}

template <int NB>
void q12_slab(const void* qa, int M, const QW& w, int b, float* y, int ldy, bool acc) {
  int m = 0;
  for (; m + 4 <= M; m += 4) q12_block<4, NB>(qa, M, m, w, b, y, ldy, acc);
  switch (M - m) {
    case 3: q12_block<3, NB>(qa, M, m, w, b, y, ldy, acc); break;
    case 2: q12_block<2, NB>(qa, M, m, w, b, y, ldy, acc); break;
    case 1: q12_block<1, NB>(qa, M, m, w, b, y, ldy, acc); break;
  }
}

void q12_gemm(const void* qa, int M, const QW& w, int n0, int n1, float* y, int ldy, bool accumulate) {
  int b = n0 / 16;
  const int b1 = n1 / 16;
  if (M <= 2)
    for (; b + 4 <= b1; b += 4) q12_slab<4>(qa, M, w, b, y, ldy, accumulate);
  for (; b + 2 <= b1; b += 2) q12_slab<2>(qa, M, w, b, y, ldy, accumulate);
  for (; b < b1; b++) q12_slab<1>(qa, M, w, b, y, ldy, accumulate);
}

// ---- int4 weights x int8 activations (vpdpbusd) --------------------------------------------
// The speech model's int4 matrices (QW4): the unsigned codes (u = w + 8) against signed 8-bit
// activations, one vpdpbusd per nibble of a 64-byte block. sum a * (u - 8) = sum a * u - 8 * sum a.
// qa layout: float scale[M] | int32 8 * sum(q)[M] | int8 rows [M][K]

size_t qact_bytes4(int M, int K) { return qa_head(M) + size_t(M) * K; }

void quantize4(const float* x, int ldx, int M, int K, const float* rot, void* qa) {
  float* scale = (float*)qa;
  int32_t* zs = (int32_t*)((char*)qa + size_t(M) * 4);
  int8_t* out = (int8_t*)qa + qa_head(M);
  alignas(64) float buf[kMaxRotK];
  for (int m = 0; m < M; m++) {
    const float* r = x + size_t(m) * ldx;
    if (rot) hadamard(r, K, rot, buf), r = buf;
    __m512 mx = _mm512_setzero_ps();
    for (int k = 0; k < K; k += 16) mx = _mm512_max_ps(mx, _mm512_abs_ps(_mm512_loadu_ps(r + k)));
    const float a = _mm512_reduce_max_ps(mx), s = a > 0 ? a / 127.0f : 1.0f;
    scale[m] = s;
    const __m512 inv = _mm512_set1_ps(1.0f / s);
    __m512i sum = _mm512_setzero_si512();
    int8_t* o = out + size_t(m) * K;
    for (int k = 0; k < K; k += 16) {
      const __m512i q = _mm512_cvtps_epi32(_mm512_mul_ps(_mm512_loadu_ps(r + k), inv));
      sum = _mm512_add_epi32(sum, q);
      _mm_storeu_si128((__m128i*)(o + k), _mm512_cvtsepi32_epi8(q));
    }
    zs[m] = 8 * _mm512_reduce_add_epi32(sum);
  }
}

template <int RM, int NB>
void q4_block(const void* qa, int M, int m0, const QW4& w, int blk0, float* y, int ldy, bool accumulate) {
  const float* scale = (const float*)qa;
  const int32_t* zs = (const int32_t*)((const char*)qa + size_t(M) * 4);
  const int8_t* xq = (const int8_t*)qa + qa_head(M);
  const int K8 = w.K / 8;
  const size_t bstride = size_t(K8) * 64;
  const uint8_t* wb = w.q + size_t(blk0) * bstride;
  const __m512i nib = _mm512_set1_epi8(0x0F);
  const int8_t* rows[RM];
  for (int r = 0; r < RM; r++) rows[r] = xq + size_t(m0 + r) * w.K;
  __m512i acc[RM][NB];
  for (int r = 0; r < RM; r++)
    for (int j = 0; j < NB; j++) acc[r][j] = _mm512_setzero_si512();
#pragma GCC unroll 2
  for (int kq = 0; kq < K8; kq++) {
    __m512i lo[NB], hi[NB];
    for (int j = 0; j < NB; j++) {
      const uint8_t* p = wb + j * bstride + size_t(kq) * 64;
      _mm_prefetch((const char*)p + 1024, _MM_HINT_T0);
      const __m512i v = _mm512_load_si512((const void*)p);
      lo[j] = _mm512_and_si512(v, nib);
      hi[j] = _mm512_and_si512(_mm512_srli_epi16(v, 4), nib);
    }
    for (int r = 0; r < RM; r++) {
      int32_t a[2];
      std::memcpy(a, rows[r] + size_t(kq) * 8, 8);
      const __m512i alo = _mm512_set1_epi32(a[0]), ahi = _mm512_set1_epi32(a[1]);
      for (int j = 0; j < NB; j++) acc[r][j] = _mm512_dpbusd_epi32(_mm512_dpbusd_epi32(acc[r][j], lo[j], alo), hi[j], ahi);
    }
  }
  for (int j = 0; j < NB; j++) {
    const int n = (blk0 + j) * 16;
    const __m512 ws = _mm512_loadu_ps(w.s + n);
    const __m512 bias = w.b ? _mm512_loadu_ps(w.b + n) : _mm512_setzero_ps();
    for (int r = 0; r < RM; r++) {
      const __m512i v = _mm512_sub_epi32(acc[r][j], _mm512_set1_epi32(zs[m0 + r]));
      __m512 f = _mm512_fmadd_ps(_mm512_cvtepi32_ps(v), _mm512_mul_ps(ws, _mm512_set1_ps(scale[m0 + r])), bias);
      float* dst = y + size_t(m0 + r) * ldy + n;
      if (accumulate) f = _mm512_add_ps(f, _mm512_loadu_ps(dst));
      _mm512_storeu_ps(dst, f);
    }
  }
}

template <int NB>
void q4_slab(const void* qa, int M, const QW4& w, int b, float* y, int ldy, bool acc) {
  int m = 0;
  for (; m + 4 <= M; m += 4) q4_block<4, NB>(qa, M, m, w, b, y, ldy, acc);
  switch (M - m) {
    case 3: q4_block<3, NB>(qa, M, m, w, b, y, ldy, acc); break;
    case 2: q4_block<2, NB>(qa, M, m, w, b, y, ldy, acc); break;
    case 1: q4_block<1, NB>(qa, M, m, w, b, y, ldy, acc); break;
  }
}

void q4_gemm(const void* qa, int M, const QW4& w, int n0, int n1, float* y, int ldy, bool accumulate) {
  int b = n0 / 16;
  const int b1 = n1 / 16;
  if (M <= 2)
    for (; b + 4 <= b1; b += 4) q4_slab<4>(qa, M, w, b, y, ldy, accumulate);
  for (; b + 2 <= b1; b += 2) q4_slab<2>(qa, M, w, b, y, ldy, accumulate);
  for (; b < b1; b++) q4_slab<1>(qa, M, w, b, y, ldy, accumulate);
}

// ---- float32 GEMM ---------------------------------------------------------------------------
// Microkernel: MR rows x 32 columns, A rows read in place (stride lda), B one panel [K][32].

constexpr int MR = 12;
constexpr int KC = 256;

// The C tile starts from C (load), the bias or zero, or C plus the bias; ELU goes on as it is stored.
template <int R>
void ukernel(const float* A, int lda, int kc, const float* B, float* C, int ldc, const float* bias, bool load, bool elu) {
  __m512 c0[R], c1[R];
  for (int r = 0; r < R; r++) {
    if (load) {
      c0[r] = _mm512_loadu_ps(C + size_t(r) * ldc);
      c1[r] = _mm512_loadu_ps(C + size_t(r) * ldc + 16);
      if (bias) {
        c0[r] = _mm512_add_ps(c0[r], _mm512_loadu_ps(bias));
        c1[r] = _mm512_add_ps(c1[r], _mm512_loadu_ps(bias + 16));
      }
    } else if (bias) {
      c0[r] = _mm512_loadu_ps(bias);
      c1[r] = _mm512_loadu_ps(bias + 16);
    } else {
      c0[r] = _mm512_setzero_ps();
      c1[r] = _mm512_setzero_ps();
    }
  }
#pragma GCC unroll 2
  for (int k = 0; k < kc; k++) {
    __m512 b0 = _mm512_load_ps(B + size_t(k) * 32), b1 = _mm512_load_ps(B + size_t(k) * 32 + 16);
    for (int r = 0; r < R; r++) {
      __m512 a = _mm512_set1_ps(A[size_t(r) * lda + k]);
      c0[r] = _mm512_fmadd_ps(a, b0, c0[r]);
      c1[r] = _mm512_fmadd_ps(a, b1, c1[r]);
    }
  }
  if (elu)
    for (int r = 0; r < R; r++) c0[r] = elu_ps(c0[r]), c1[r] = elu_ps(c1[r]);
  for (int r = 0; r < R; r++) {
    _mm512_storeu_ps(C + size_t(r) * ldc, c0[r]);
    _mm512_storeu_ps(C + size_t(r) * ldc + 16, c1[r]);
  }
}

using UK = void (*)(const float*, int, int, const float*, float*, int, const float*, bool, bool);
constexpr UK kUK[MR + 1] = {nullptr,     ukernel<1>, ukernel<2>, ukernel<3>,  ukernel<4>,  ukernel<5>, ukernel<6>,
                            ukernel<7>,  ukernel<8>, ukernel<9>, ukernel<10>, ukernel<11>, ukernel<12>};

constexpr size_t kCachedB = 256 * 1024;  // bytes of B that stay in L2 while a row tile passes

void f32_gemm(const float* A, int lda, int M, int K, const float* panels, const float* bias, int n0, int n1,
              float* C, int ldc, int flags) {
  const bool acc = flags & kAccumulate, elu = flags & kElu;
  auto tile = [&](int m, int n, int k0) {
    const int kc = K - k0 < KC ? K - k0 : KC;
    kUK[M - m < MR ? M - m : MR](A + size_t(m) * lda + k0, lda, kc, panels + size_t(n / 32) * K * 32 + size_t(k0) * 32,
                                 C + size_t(m) * ldc + n, ldc, k0 == 0 && bias ? bias + n : nullptr, acc || k0 > 0,
                                 elu && k0 + kc == K);
  };
  if (size_t(K) * (n1 - n0) * 4 <= kCachedB) {  // B stays in cache: rows outer, so A and C pass once
    for (int m = 0; m < M; m += MR)
      for (int k0 = 0; k0 < K; k0 += KC)
        for (int n = n0; n < n1; n += 32) tile(m, n, k0);
  } else {  // B streams: a K block of a panel stays in L1 while every row passes
    for (int k0 = 0; k0 < K; k0 += KC)
      for (int n = n0; n < n1; n += 32)
        for (int m = 0; m < M; m += MR) tile(m, n, k0);
  }
}

// ---- attention over a float16 cache --------------------------------------------------------

void attn_f16(const float* q, const uint16_t* K, const uint16_t* V, int n, int D, float* out, float* scores) {
  const int nb = (n + 15) / 16;
  int b = 0;
  for (; b + 4 <= nb; b += 4) {
    __m512 a0 = _mm512_setzero_ps(), a1 = a0, a2 = a0, a3 = a0;
    const uint16_t* k0 = K + size_t(b) * D * 16;
    for (int d = 0; d < D; d++) {
      __m512 qd = _mm512_set1_ps(q[d]);
      a0 = _mm512_fmadd_ps(qd, _mm512_cvtph_ps(_mm256_loadu_si256((const __m256i*)(k0 + d * 16))), a0);
      a1 = _mm512_fmadd_ps(qd, _mm512_cvtph_ps(_mm256_loadu_si256((const __m256i*)(k0 + (D + d) * 16))), a1);
      a2 = _mm512_fmadd_ps(qd, _mm512_cvtph_ps(_mm256_loadu_si256((const __m256i*)(k0 + (2 * D + d) * 16))), a2);
      a3 = _mm512_fmadd_ps(qd, _mm512_cvtph_ps(_mm256_loadu_si256((const __m256i*)(k0 + (3 * D + d) * 16))), a3);
    }
    _mm512_storeu_ps(scores + b * 16, a0);
    _mm512_storeu_ps(scores + b * 16 + 16, a1);
    _mm512_storeu_ps(scores + b * 16 + 32, a2);
    _mm512_storeu_ps(scores + b * 16 + 48, a3);
  }
  for (; b < nb; b++) {
    __m512 a0 = _mm512_setzero_ps();
    const uint16_t* k0 = K + size_t(b) * D * 16;
    for (int d = 0; d < D; d++)
      a0 = _mm512_fmadd_ps(_mm512_set1_ps(q[d]), _mm512_cvtph_ps(_mm256_loadu_si256((const __m256i*)(k0 + d * 16))), a0);
    _mm512_storeu_ps(scores + b * 16, a0);
  }
  const float sum = softmax_exp(scores, n);
  // out = sum_t p_t V_t, two positions per iteration for 8 independent accumulators
  const int dv = D / 16;  // D is a multiple of 16
  __m512 acc[8];
  for (int i = 0; i < 8; i++) acc[i] = _mm512_setzero_ps();
  int t = 0;
  for (; t + 2 <= n; t += 2) {
    __m512 p0 = _mm512_set1_ps(scores[t]), p1 = _mm512_set1_ps(scores[t + 1]);
    const uint16_t* v0 = V + size_t(t) * D;
    for (int j = 0; j < dv; j++) {
      acc[j] = _mm512_fmadd_ps(p0, _mm512_cvtph_ps(_mm256_loadu_si256((const __m256i*)(v0 + j * 16))), acc[j]);
      acc[4 + j] = _mm512_fmadd_ps(p1, _mm512_cvtph_ps(_mm256_loadu_si256((const __m256i*)(v0 + D + j * 16))), acc[4 + j]);
    }
  }
  for (; t < n; t++) {
    __m512 p0 = _mm512_set1_ps(scores[t]);
    for (int j = 0; j < dv; j++)
      acc[j] = _mm512_fmadd_ps(p0, _mm512_cvtph_ps(_mm256_loadu_si256((const __m256i*)(V + size_t(t) * D + j * 16))), acc[j]);
  }
  __m512 inv = _mm512_set1_ps(1.0f / sum);
  for (int j = 0; j < dv; j++) _mm512_storeu_ps(out + j * 16, _mm512_mul_ps(_mm512_add_ps(acc[j], acc[4 + j]), inv));
}

const Kernels kTable = {
    "avx512",
    {qact_bytes12, quantize12, q12_gemm},
    {qact_bytes, quantize, q8_gemm},
    8,
    {qact_bytes4, quantize4, q4_gemm},
    f32_gemm, attn_f16, layernorm, gelu_tanh, silu, elu, softmax_exp, f32_to_f16, dot, hadamard,
    nullptr, nullptr, nullptr,
};

}  // namespace

const Kernels& kernels_avx512() { return kTable; }

}  // namespace pk
