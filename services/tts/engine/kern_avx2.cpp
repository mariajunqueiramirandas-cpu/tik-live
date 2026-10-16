// AVX2 + FMA + F16C kernels, for CPUs without AVX-512 (Zen 2/3, Haswell to Skylake client). Built a
// second time with AVX-VNNI (Alder Lake and later clients, Sierra Forest Xeons), whose vpdpbusd and
// vpdpwssd fuse each integer dot product and its add, and cannot saturate.
#include <immintrin.h>

#include <cmath>

#include "internal.h"

namespace pk {
namespace {

inline __m256 exp_ps(__m256 x) {
  x = _mm256_min_ps(_mm256_max_ps(x, _mm256_set1_ps(-87.3f)), _mm256_set1_ps(88.7f));
  __m256 n = _mm256_round_ps(_mm256_mul_ps(x, _mm256_set1_ps(1.44269504088896341f)),
                             _MM_FROUND_TO_NEAREST_INT | _MM_FROUND_NO_EXC);
  __m256 r = _mm256_fnmadd_ps(n, _mm256_set1_ps(0.693359375f), x);
  r = _mm256_fnmadd_ps(n, _mm256_set1_ps(-2.12194440e-4f), r);
  __m256 p = _mm256_set1_ps(1.9875691500E-4f);
  p = _mm256_fmadd_ps(p, r, _mm256_set1_ps(1.3981999507E-3f));
  p = _mm256_fmadd_ps(p, r, _mm256_set1_ps(8.3334519073E-3f));
  p = _mm256_fmadd_ps(p, r, _mm256_set1_ps(4.1665795894E-2f));
  p = _mm256_fmadd_ps(p, r, _mm256_set1_ps(1.6666665459E-1f));
  p = _mm256_fmadd_ps(p, r, _mm256_set1_ps(5.0000001201E-1f));
  __m256 y = _mm256_fmadd_ps(p, _mm256_mul_ps(r, r), _mm256_add_ps(r, _mm256_set1_ps(1.0f)));
  // 2^n for n in [-126, 128): two steps so n = 128 (x near 88.7) stays finite
  __m256i ni = _mm256_cvtps_epi32(n);
  __m256i h = _mm256_srai_epi32(ni, 1);
  __m256 s1 = _mm256_castsi256_ps(_mm256_slli_epi32(_mm256_add_epi32(h, _mm256_set1_epi32(127)), 23));
  __m256 s2 = _mm256_castsi256_ps(_mm256_slli_epi32(_mm256_add_epi32(_mm256_sub_epi32(ni, h), _mm256_set1_epi32(127)), 23));
  return _mm256_mul_ps(_mm256_mul_ps(y, s1), s2);
}

// exp(x) for |x| <= 87 (callers clamp): rounding to an integer n by adding 1.5 * 2^23 + 127 leaves
// n + 127 in the low mantissa bits, which shift straight into 2^n. No round or convert instructions.
inline __m256 exp_mid(__m256 x) {
  const __m256 magic = _mm256_set1_ps(12583039.0f);
  const __m256 t = _mm256_fmadd_ps(x, _mm256_set1_ps(1.44269504088896341f), magic);
  const __m256 n = _mm256_sub_ps(t, magic);
  __m256 r = _mm256_fnmadd_ps(n, _mm256_set1_ps(0.693359375f), x);
  r = _mm256_fnmadd_ps(n, _mm256_set1_ps(-2.12194440e-4f), r);
  __m256 p = _mm256_set1_ps(1.9875691500E-4f);
  p = _mm256_fmadd_ps(p, r, _mm256_set1_ps(1.3981999507E-3f));
  p = _mm256_fmadd_ps(p, r, _mm256_set1_ps(8.3334519073E-3f));
  p = _mm256_fmadd_ps(p, r, _mm256_set1_ps(4.1665795894E-2f));
  p = _mm256_fmadd_ps(p, r, _mm256_set1_ps(1.6666665459E-1f));
  p = _mm256_fmadd_ps(p, r, _mm256_set1_ps(5.0000001201E-1f));
  const __m256 y = _mm256_fmadd_ps(p, _mm256_mul_ps(r, r), _mm256_add_ps(r, _mm256_set1_ps(1.0f)));
  return _mm256_mul_ps(y, _mm256_castsi256_ps(_mm256_slli_epi32(_mm256_castps_si256(t), 23)));
}

inline float hsum(__m256 v) {
  __m128 s = _mm_add_ps(_mm256_castps256_ps128(v), _mm256_extractf128_ps(v, 1));
  s = _mm_add_ps(s, _mm_movehl_ps(s, s));
  s = _mm_add_ss(s, _mm_movehdup_ps(s));
  return _mm_cvtss_f32(s);
}

inline float hmax(__m256 v) {
  __m128 s = _mm_max_ps(_mm256_castps256_ps128(v), _mm256_extractf128_ps(v, 1));
  s = _mm_max_ps(s, _mm_movehl_ps(s, s));
  s = _mm_max_ss(s, _mm_movehdup_ps(s));
  return _mm_cvtss_f32(s);
}

void layernorm(const float* x, int n, const float* w, const float* b, float eps, float* y) {
  __m256 s = _mm256_setzero_ps();
  int i = 0;
  for (; i + 8 <= n; i += 8) s = _mm256_add_ps(s, _mm256_loadu_ps(x + i));
  float mean = hsum(s);
  for (; i < n; i++) mean += x[i];
  mean /= n;
  __m256 m = _mm256_set1_ps(mean), v = _mm256_setzero_ps();
  for (i = 0; i + 8 <= n; i += 8) {
    __m256 d = _mm256_sub_ps(_mm256_loadu_ps(x + i), m);
    v = _mm256_fmadd_ps(d, d, v);
  }
  float var = hsum(v);
  for (; i < n; i++) var += (x[i] - mean) * (x[i] - mean);
  var /= n;
  float inv = 1.0f / std::sqrt(var + eps);
  __m256 iv = _mm256_set1_ps(inv);
  for (i = 0; i + 8 <= n; i += 8) {
    __m256 t = _mm256_mul_ps(_mm256_sub_ps(_mm256_loadu_ps(x + i), m), iv);
    if (w) t = _mm256_fmadd_ps(t, _mm256_loadu_ps(w + i), _mm256_loadu_ps(b + i));
    _mm256_storeu_ps(y + i, t);
  }
  for (; i < n; i++) {
    float t = (x[i] - mean) * inv;
    y[i] = w ? t * w[i] + b[i] : t;
  }
}

// 0.5 x (1 + tanh(u)) = x / (1 + exp(-2u)); the reciprocal is rcp plus one Newton step, not a divide
inline __m256 gelu_ps(__m256 x) {
  const __m256 x3 = _mm256_mul_ps(_mm256_mul_ps(x, x), x);
  __m256 u2 = _mm256_mul_ps(_mm256_set1_ps(-1.5957691216057308f), _mm256_fmadd_ps(_mm256_set1_ps(0.044715f), x3, x));
  u2 = _mm256_min_ps(_mm256_max_ps(u2, _mm256_set1_ps(-87.0f)), _mm256_set1_ps(87.0f));
  const __m256 d = _mm256_add_ps(exp_mid(u2), _mm256_set1_ps(1.0f));
  __m256 r = _mm256_rcp_ps(d);
  r = _mm256_mul_ps(r, _mm256_fnmadd_ps(d, r, _mm256_set1_ps(2.0f)));
  return _mm256_mul_ps(x, r);
}

inline __m256 silu_ps(__m256 x) {
  return _mm256_div_ps(x, _mm256_add_ps(_mm256_set1_ps(1.0f), exp_ps(_mm256_sub_ps(_mm256_setzero_ps(), x))));
}

inline __m256 elu_ps(__m256 x) {
  const __m256 neg = _mm256_max_ps(_mm256_min_ps(x, _mm256_setzero_ps()), _mm256_set1_ps(-87.0f));
  const __m256 e = _mm256_sub_ps(exp_mid(neg), _mm256_set1_ps(1.0f));
  return _mm256_blendv_ps(e, x, _mm256_cmp_ps(x, _mm256_setzero_ps(), _CMP_GT_OQ));
}

template <__m256 (*F)(__m256)>
void map(const float* x, int n, float* y) {
  int i = 0;
  for (; i + 8 <= n; i += 8) _mm256_storeu_ps(y + i, F(_mm256_loadu_ps(x + i)));
  if (i < n) {
    alignas(32) float t[8] = {0};
    for (int j = 0; i + j < n; j++) t[j] = x[i + j];
    _mm256_store_ps(t, F(_mm256_load_ps(t)));
    for (int j = 0; i + j < n; j++) y[i + j] = t[j];
  }
}

void gelu_tanh(float* x, int n) { map<gelu_ps>(x, n, x); }
void silu(float* x, int n) { map<silu_ps>(x, n, x); }
void elu(const float* x, int n, float* y) { map<elu_ps>(x, n, y); }

float softmax_exp(float* x, int n) {
  __m256 mx = _mm256_set1_ps(-INFINITY);
  int i = 0;
  for (; i + 8 <= n; i += 8) mx = _mm256_max_ps(mx, _mm256_loadu_ps(x + i));
  float m = hmax(mx);
  for (; i < n; i++) m = x[i] > m ? x[i] : m;
  __m256 vm = _mm256_set1_ps(m), s = _mm256_setzero_ps();
  for (i = 0; i + 8 <= n; i += 8) {
    __m256 e = exp_ps(_mm256_sub_ps(_mm256_loadu_ps(x + i), vm));
    _mm256_storeu_ps(x + i, e);
    s = _mm256_add_ps(s, e);
  }
  float sum = hsum(s);
  for (; i < n; i++) {
    x[i] = std::exp(x[i] - m);
    sum += x[i];
  }
  return sum;
}

void f32_to_f16(const float* x, int n, uint16_t* y) {
  int i = 0;
  for (; i + 8 <= n; i += 8)
    _mm_storeu_si128((__m128i*)(y + i), _mm256_cvtps_ph(_mm256_loadu_ps(x + i), _MM_FROUND_TO_NEAREST_INT));
  for (; i < n; i++) y[i] = _cvtss_sh(x[i], _MM_FROUND_TO_NEAREST_INT);
}

// y = H (signs * x), H the n x n Sylvester Hadamard matrix (unnormalized), n a power of two >= 8.
// The first three stages run inside each vector, the rest between vectors, all in L1.
void hadamard(const float* x, int n, const float* signs, float* y) {
  const __m256 s1 = _mm256_setr_ps(1, -1, 1, -1, 1, -1, 1, -1), s2 = _mm256_setr_ps(1, 1, -1, -1, 1, 1, -1, -1);
  const __m256 s4 = _mm256_setr_ps(1, 1, 1, 1, -1, -1, -1, -1);
  for (int i = 0; i < n; i += 8) {
    __m256 v = _mm256_mul_ps(_mm256_loadu_ps(x + i), _mm256_loadu_ps(signs + i));
    v = _mm256_fmadd_ps(v, s1, _mm256_permute_ps(v, 0xB1));
    v = _mm256_fmadd_ps(v, s2, _mm256_permute_ps(v, 0x4E));
    v = _mm256_fmadd_ps(v, s4, _mm256_permute2f128_ps(v, v, 1));
    _mm256_storeu_ps(y + i, v);
  }
  for (int h = 8; h < n; h *= 2)
    for (int i = 0; i < n; i += 2 * h)
      for (int j = i; j < i + h; j += 8) {
        const __m256 a = _mm256_loadu_ps(y + j), b = _mm256_loadu_ps(y + j + h);
        _mm256_storeu_ps(y + j, _mm256_add_ps(a, b));
        _mm256_storeu_ps(y + j + h, _mm256_sub_ps(a, b));
      }
}

float dot(const float* a, const float* b, int n) {
  __m256 s0 = _mm256_setzero_ps(), s1 = s0;
  int i = 0;
  for (; i + 16 <= n; i += 16) {
    s0 = _mm256_fmadd_ps(_mm256_loadu_ps(a + i), _mm256_loadu_ps(b + i), s0);
    s1 = _mm256_fmadd_ps(_mm256_loadu_ps(a + i + 8), _mm256_loadu_ps(b + i + 8), s1);
  }
  float s = hsum(_mm256_add_ps(s0, s1));
  for (; i < n; i++) s += a[i] * b[i];
  return s;
}

// ---- int8 weights x int16 activations -----------------------------------------------------
// No VNNI: weights are sign-extended to int16 and multiplied with vpmaddwd, which cannot
// saturate. Activations get 12 bits (symmetric), so K=4096 rows stay inside int32.
// qa layout: float scale[M] | int32 unused[M] | int16 rows [M][K]

constexpr float kQMax = 2047.0f;

inline size_t qa_head(int M) { return (size_t(M) * 8 + 63) & ~size_t(63); }

size_t qact_bytes(int M, int K) { return qa_head(M) + size_t(M) * K * 2; }

void quantize(const float* x, int ldx, int M, int K, const float* rot, void* qa) {
  float* scale = (float*)qa;
  int16_t* out = (int16_t*)((char*)qa + qa_head(M));
  const __m256 sign = _mm256_set1_ps(-0.0f);
  alignas(32) float buf[kMaxRotK];
  for (int m = 0; m < M; m++) {
    const float* r = x + size_t(m) * ldx;
    if (rot) hadamard(r, K, rot, buf), r = buf;
    __m256 mx = _mm256_setzero_ps();
    int k = 0;
    for (; k + 8 <= K; k += 8) mx = _mm256_max_ps(mx, _mm256_andnot_ps(sign, _mm256_loadu_ps(r + k)));
    float a = hmax(mx);
    for (; k < K; k++) a = std::fabs(r[k]) > a ? std::fabs(r[k]) : a;
    float s = a > 0 ? a / kQMax : 1.0f;
    scale[m] = s;
    __m256 inv = _mm256_set1_ps(1.0f / s);
    int16_t* o = out + size_t(m) * K;
    for (k = 0; k + 16 <= K; k += 16) {
      __m256i q0 = _mm256_cvtps_epi32(_mm256_mul_ps(_mm256_loadu_ps(r + k), inv));
      __m256i q1 = _mm256_cvtps_epi32(_mm256_mul_ps(_mm256_loadu_ps(r + k + 8), inv));
      __m256i p = _mm256_permute4x64_epi64(_mm256_packs_epi32(q0, q1), 0xD8);
      _mm256_storeu_si256((__m256i*)(o + k), p);
    }
    for (; k < K; k++) o[k] = (int16_t)std::nearbyint(r[k] / s);
  }
}

// NB blocks of 16 outputs for RM rows. A lone sequential weight stream is held back by how many
// misses the prefetcher keeps in flight, so blocks run side by side and a software prefetch reads
// ahead of each.
template <int RM, int NB>
void q8_block(const void* qa, int M, int m0, const QW& w, int blk0, float* y, int ldy, bool accumulate) {
  const float* scale = (const float*)qa;
  const int16_t* xq = (const int16_t*)((const char*)qa + qa_head(M));
  const int K4 = w.K / 4;
  const size_t bstride = size_t(K4) * 64;
  const int8_t* wb = w.q + size_t(blk0) * bstride;
  __m256i acc[RM][NB][4];
  for (int r = 0; r < RM; r++)
    for (int j = 0; j < NB; j++)
      for (int c = 0; c < 4; c++) acc[r][j][c] = _mm256_setzero_si256();
  const int16_t* rows[RM];
  for (int r = 0; r < RM; r++) rows[r] = xq + size_t(m0 + r) * w.K;
#pragma GCC unroll 2
  for (int kq = 0; kq < K4; kq++) {
    long long a4[RM];
    for (int r = 0; r < RM; r++) std::memcpy(&a4[r], rows[r] + size_t(kq) * 4, 8);
    for (int j = 0; j < NB; j++) {
      const int8_t* p = wb + j * bstride + size_t(kq) * 64;
      _mm_prefetch((const char*)p + 2048, _MM_HINT_T0);
      for (int c = 0; c < 4; c++) {
        const __m256i wv = _mm256_cvtepi8_epi16(_mm_load_si128((const __m128i*)(p + c * 16)));
        for (int r = 0; r < RM; r++)
#ifdef __AVXVNNI__
          acc[r][j][c] = _mm256_dpwssd_avx_epi32(acc[r][j][c], wv, _mm256_set1_epi64x(a4[r]));
#else
          acc[r][j][c] = _mm256_add_epi32(acc[r][j][c], _mm256_madd_epi16(wv, _mm256_set1_epi64x(a4[r])));
#endif
      }
    }
  }
  for (int j = 0; j < NB; j++) {
    const int n = (blk0 + j) * 16;
    for (int r = 0; r < RM; r++) {
      __m256i lo = _mm256_permute4x64_epi64(_mm256_hadd_epi32(acc[r][j][0], acc[r][j][1]), 0xD8);
      __m256i hi = _mm256_permute4x64_epi64(_mm256_hadd_epi32(acc[r][j][2], acc[r][j][3]), 0xD8);
      __m256 sa = _mm256_set1_ps(scale[m0 + r]);
      float* dst = y + size_t(m0 + r) * ldy + n;
      __m256 f0 = _mm256_mul_ps(_mm256_cvtepi32_ps(lo), _mm256_mul_ps(_mm256_loadu_ps(w.s + n), sa));
      __m256 f1 = _mm256_mul_ps(_mm256_cvtepi32_ps(hi), _mm256_mul_ps(_mm256_loadu_ps(w.s + n + 8), sa));
      if (w.b) {
        f0 = _mm256_add_ps(f0, _mm256_loadu_ps(w.b + n));
        f1 = _mm256_add_ps(f1, _mm256_loadu_ps(w.b + n + 8));
      }
      if (accumulate) {
        f0 = _mm256_add_ps(f0, _mm256_loadu_ps(dst));
        f1 = _mm256_add_ps(f1, _mm256_loadu_ps(dst + 8));
      }
      _mm256_storeu_ps(dst, f0);
      _mm256_storeu_ps(dst + 8, f1);
    }
  }
}

// Weights outer: a slab of NB blocks stays in cache while every pair of rows passes.
template <int NB>
void q8_slab(const void* qa, int M, const QW& w, int b, float* y, int ldy, bool acc) {
  int m = 0;
  for (; m + 2 <= M; m += 2) q8_block<2, NB>(qa, M, m, w, b, y, ldy, acc);
  if (m < M) q8_block<1, NB>(qa, M, m, w, b, y, ldy, acc);
}

void q8_gemm(const void* qa, int M, const QW& w, int n0, int n1, float* y, int ldy, bool accumulate) {
  int b = n0 / 16;
  const int b1 = n1 / 16;
  if (M == 1)
    for (; b + 2 <= b1; b += 2) q8_slab<2>(qa, M, w, b, y, ldy, accumulate);
  for (; b < b1; b++) q8_slab<1>(qa, M, w, b, y, ldy, accumulate);
}

// ---- uint8 activations x 7-bit weights (vpmaddubsw) ---------------------------------------
// The decoder's compute-bound rows: 32 products per instruction, where an FMA does 8. Weights keep
// 7 bits (|w| <= 63) so a pair of products, at most 2 * 255 * 63, cannot saturate int16; the
// decoder builds them at startup from its float32 copy (Kernels::fast_wbits). Lanes come out one per
// column, so no horizontal adds. qa layout: float scale[M] | int32 zero[M] | uint8 rows [M][K]

size_t qact_bytes_u8(int M, int K) { return qa_head(M) + size_t(M) * K; }

void quantize_u8(const float* x, int ldx, int M, int K, const float* rot, void* qa) {
  float* scale = (float*)qa;
  int32_t* zero = (int32_t*)((char*)qa + size_t(M) * 4);
  uint8_t* out = (uint8_t*)qa + qa_head(M);
  alignas(32) float buf[kMaxRotK];
  for (int m = 0; m < M; m++) {
    const float* r = x + size_t(m) * ldx;
    if (rot) hadamard(r, K, rot, buf), r = buf;
    __m256 lo = _mm256_setzero_ps(), hi = _mm256_setzero_ps();
    int k = 0;
    for (; k + 8 <= K; k += 8) {
      const __m256 v = _mm256_loadu_ps(r + k);
      lo = _mm256_min_ps(lo, v);
      hi = _mm256_max_ps(hi, v);
    }
    float mn = -hmax(_mm256_sub_ps(_mm256_setzero_ps(), lo)), mx = hmax(hi);
    for (; k < K; k++) mn = r[k] < mn ? r[k] : mn, mx = r[k] > mx ? r[k] : mx;
    float s = (mx - mn) / 255.0f;
    if (!(s > 0)) s = 1.0f;
    int z = (int)std::nearbyint(-mn / s);
    z = z < 0 ? 0 : z > 255 ? 255 : z;
    scale[m] = s;
    zero[m] = z;
    const __m256 inv = _mm256_set1_ps(1.0f / s);
    const __m256i vz = _mm256_set1_epi32(z);
    uint8_t* o = out + size_t(m) * K;
    for (k = 0; k + 16 <= K; k += 16) {
      const __m256i q0 = _mm256_add_epi32(_mm256_cvtps_epi32(_mm256_mul_ps(_mm256_loadu_ps(r + k), inv)), vz);
      const __m256i q1 = _mm256_add_epi32(_mm256_cvtps_epi32(_mm256_mul_ps(_mm256_loadu_ps(r + k + 8), inv)), vz);
      const __m256i p = _mm256_permute4x64_epi64(_mm256_packs_epi32(q0, q1), 0xD8);  // saturating packs clamp
      _mm_storeu_si128((__m128i*)(o + k), _mm_packus_epi16(_mm256_castsi256_si128(p), _mm256_extracti128_si256(p, 1)));
    }
    for (; k < K; k++) {
      const int q = (int)std::nearbyint(r[k] / s) + z;
      o[k] = (uint8_t)(q < 0 ? 0 : q > 255 ? 255 : q);
    }
  }
}

template <int RM>
void q8u_block(const void* qa, int M, int m0, const QW& w, int blk, float* y, int ldy, bool accumulate) {
  const float* scale = (const float*)qa;
  const int32_t* zero = (const int32_t*)((const char*)qa + size_t(M) * 4);
  const uint8_t* xq = (const uint8_t*)qa + qa_head(M);
  const int K4 = w.K / 4;
  const int8_t* wb = w.q + size_t(blk) * K4 * 64;
  const uint8_t* rows[RM];
  for (int r = 0; r < RM; r++) rows[r] = xq + size_t(m0 + r) * w.K;
#ifndef __AVXVNNI__
  const __m256i ones = _mm256_set1_epi16(1);
#endif
  __m256i acc[RM][2];
  for (int r = 0; r < RM; r++) acc[r][0] = acc[r][1] = _mm256_setzero_si256();
#pragma GCC unroll 2
  for (int kq = 0; kq < K4; kq++) {
    const __m256i w0 = _mm256_load_si256((const __m256i*)(wb + size_t(kq) * 64));
    const __m256i w1 = _mm256_load_si256((const __m256i*)(wb + size_t(kq) * 64 + 32));
    for (int r = 0; r < RM; r++) {
      int32_t a4;
      std::memcpy(&a4, rows[r] + size_t(kq) * 4, 4);
      const __m256i a = _mm256_set1_epi32(a4);
#ifdef __AVXVNNI__
      acc[r][0] = _mm256_dpbusd_avx_epi32(acc[r][0], a, w0);
      acc[r][1] = _mm256_dpbusd_avx_epi32(acc[r][1], a, w1);
#else
      acc[r][0] = _mm256_add_epi32(acc[r][0], _mm256_madd_epi16(_mm256_maddubs_epi16(a, w0), ones));
      acc[r][1] = _mm256_add_epi32(acc[r][1], _mm256_madd_epi16(_mm256_maddubs_epi16(a, w1), ones));
#endif
    }
  }
  const int n = blk * 16;
  for (int h = 0; h < 2; h++) {
    const __m256i wz = _mm256_loadu_si256((const __m256i*)(w.z + n + h * 8));
    const __m256 ws = _mm256_loadu_ps(w.s + n + h * 8);
    const __m256 bias = w.b ? _mm256_loadu_ps(w.b + n + h * 8) : _mm256_setzero_ps();
    for (int r = 0; r < RM; r++) {
      const __m256i v = _mm256_sub_epi32(acc[r][h], _mm256_mullo_epi32(_mm256_set1_epi32(zero[m0 + r]), wz));
      __m256 f = _mm256_fmadd_ps(_mm256_cvtepi32_ps(v), _mm256_mul_ps(ws, _mm256_set1_ps(scale[m0 + r])), bias);
      float* dst = y + size_t(m0 + r) * ldy + n + h * 8;
      if (accumulate) f = _mm256_add_ps(f, _mm256_loadu_ps(dst));
      _mm256_storeu_ps(dst, f);
    }
  }
}

// weights outer: one block's weights stay in L1 while every four rows pass
void q8u_gemm(const void* qa, int M, const QW& w, int n0, int n1, float* y, int ldy, bool accumulate) {
  for (int b = n0 / 16; b < n1 / 16; b++) {
    int m = 0;
    for (; m + 4 <= M; m += 4) q8u_block<4>(qa, M, m, w, b, y, ldy, accumulate);
    switch (M - m) {
      case 3: q8u_block<3>(qa, M, m, w, b, y, ldy, accumulate); break;
      case 2: q8u_block<2>(qa, M, m, w, b, y, ldy, accumulate); break;
      case 1: q8u_block<1>(qa, M, m, w, b, y, ldy, accumulate); break;
    }
  }
}

// ---- int4 weights x int8 activations (vpmaddubsw) ------------------------------------------
// The speech model's int4 matrices (QW4). The codes are unsigned (u = w + 8), so vpmaddubsw takes them
// as its unsigned side against signed 8-bit activations: a pair of products is at most 2 * 15 * 127,
// and four steps of 8 k (32 products per lane) still fit int16 before one vpmaddwd widens them.
// sum a * (u - 8) = sum a * u - 8 * sum a, the second term per row from quantize4.
// qa layout: float scale[M] | int32 8 * sum(q)[M] | int8 rows [M][K]

size_t qact_bytes4(int M, int K) { return qa_head(M) + size_t(M) * K; }

void quantize4(const float* x, int ldx, int M, int K, const float* rot, void* qa) {
  float* scale = (float*)qa;
  int32_t* zs = (int32_t*)((char*)qa + size_t(M) * 4);
  int8_t* out = (int8_t*)qa + qa_head(M);
  const __m256 sign = _mm256_set1_ps(-0.0f);
  const __m256i order = _mm256_setr_epi32(0, 4, 1, 5, 2, 6, 3, 7);
  alignas(32) float buf[kMaxRotK];
  for (int m = 0; m < M; m++) {
    const float* r = x + size_t(m) * ldx;
    if (rot) hadamard(r, K, rot, buf), r = buf;
    __m256 mx = _mm256_setzero_ps();
    for (int k = 0; k < K; k += 8) mx = _mm256_max_ps(mx, _mm256_andnot_ps(sign, _mm256_loadu_ps(r + k)));
    const float a = hmax(mx), s = a > 0 ? a / 127.0f : 1.0f;
    scale[m] = s;
    const __m256 inv = _mm256_set1_ps(1.0f / s);
    __m256i sum = _mm256_setzero_si256();
    int8_t* o = out + size_t(m) * K;
    for (int k = 0; k < K; k += 32) {
      __m256i q[4];
      for (int i = 0; i < 4; i++) {
        q[i] = _mm256_cvtps_epi32(_mm256_mul_ps(_mm256_loadu_ps(r + k + 8 * i), inv));
        sum = _mm256_add_epi32(sum, q[i]);
      }
      const __m256i b = _mm256_packs_epi16(_mm256_packs_epi32(q[0], q[1]), _mm256_packs_epi32(q[2], q[3]));
      _mm256_storeu_si256((__m256i*)(o + k), _mm256_permutevar8x32_epi32(b, order));
    }
    __m128i t = _mm_add_epi32(_mm256_castsi256_si128(sum), _mm256_extracti128_si256(sum, 1));
    t = _mm_add_epi32(t, _mm_shuffle_epi32(t, 0x4E));
    t = _mm_add_epi32(t, _mm_shuffle_epi32(t, 0xB1));
    zs[m] = 8 * _mm_cvtsi128_si32(t);
  }
}

// RM rows x NB blocks of 16 columns; blocks side by side keep several weight streams in flight.
template <int RM, int NB>
void q4_block(const void* qa, int M, int m0, const QW4& w, int blk0, float* y, int ldy, bool accumulate) {
  const float* scale = (const float*)qa;
  const int32_t* zs = (const int32_t*)((const char*)qa + size_t(M) * 4);
  const int8_t* xq = (const int8_t*)qa + qa_head(M);
  const int K8 = w.K / 8;
  const size_t bstride = size_t(K8) * 64;
  const uint8_t* wb = w.q + size_t(blk0) * bstride;
  const __m256i nib = _mm256_set1_epi8(0x0F);
  const int8_t* rows[RM];
  for (int r = 0; r < RM; r++) rows[r] = xq + size_t(m0 + r) * w.K;
  __m256i acc[RM][NB][2];
  for (int r = 0; r < RM; r++)
    for (int j = 0; j < NB; j++) acc[r][j][0] = acc[r][j][1] = _mm256_setzero_si256();
  for (int k4 = 0; k4 < K8; k4 += 4) {
#ifndef __AVXVNNI__
    __m256i part[RM][NB][2];
    for (int r = 0; r < RM; r++)
      for (int j = 0; j < NB; j++) part[r][j][0] = part[r][j][1] = _mm256_setzero_si256();
#endif
    for (int kq = k4; kq < k4 + 4; kq++) {
      __m256i alo[RM], ahi[RM];
      for (int r = 0; r < RM; r++) {
        int32_t a[2];
        std::memcpy(a, rows[r] + size_t(kq) * 8, 8);
        alo[r] = _mm256_set1_epi32(a[0]);
        ahi[r] = _mm256_set1_epi32(a[1]);
      }
      for (int j = 0; j < NB; j++) {
        const uint8_t* p = wb + j * bstride + size_t(kq) * 64;
        _mm_prefetch((const char*)p + 1024, _MM_HINT_T0);
        for (int h = 0; h < 2; h++) {
          const __m256i v = _mm256_load_si256((const __m256i*)(p + 32 * h));
          const __m256i lo = _mm256_and_si256(v, nib), hi = _mm256_and_si256(_mm256_srli_epi16(v, 4), nib);
          for (int r = 0; r < RM; r++)
#ifdef __AVXVNNI__
            acc[r][j][h] = _mm256_dpbusd_avx_epi32(_mm256_dpbusd_avx_epi32(acc[r][j][h], lo, alo[r]), hi, ahi[r]);
#else
            part[r][j][h] = _mm256_add_epi16(
                part[r][j][h], _mm256_add_epi16(_mm256_maddubs_epi16(lo, alo[r]), _mm256_maddubs_epi16(hi, ahi[r])));
#endif
        }
      }
    }
#ifndef __AVXVNNI__
    const __m256i ones = _mm256_set1_epi16(1);
    for (int r = 0; r < RM; r++)
      for (int j = 0; j < NB; j++)
        for (int h = 0; h < 2; h++) acc[r][j][h] = _mm256_add_epi32(acc[r][j][h], _mm256_madd_epi16(part[r][j][h], ones));
#endif
  }
  for (int j = 0; j < NB; j++)
    for (int h = 0; h < 2; h++) {
      const int n = (blk0 + j) * 16 + h * 8;
      const __m256 ws = _mm256_loadu_ps(w.s + n);
      const __m256 bias = w.b ? _mm256_loadu_ps(w.b + n) : _mm256_setzero_ps();
      for (int r = 0; r < RM; r++) {
        const __m256i v = _mm256_sub_epi32(acc[r][j][h], _mm256_set1_epi32(zs[m0 + r]));
        __m256 f = _mm256_fmadd_ps(_mm256_cvtepi32_ps(v), _mm256_mul_ps(ws, _mm256_set1_ps(scale[m0 + r])), bias);
        float* dst = y + size_t(m0 + r) * ldy + n;
        if (accumulate) f = _mm256_add_ps(f, _mm256_loadu_ps(dst));
        _mm256_storeu_ps(dst, f);
      }
    }
}

// Weights outer: a block's weights (K * 8 bytes) stay in L1 while every pair of rows passes.
void q4_gemm(const void* qa, int M, const QW4& w, int n0, int n1, float* y, int ldy, bool accumulate) {
  int b = n0 / 16;
  const int b1 = n1 / 16;
  if (M == 1) {
    for (; b + 2 <= b1; b += 2) q4_block<1, 2>(qa, M, 0, w, b, y, ldy, accumulate);
    if (b < b1) q4_block<1, 1>(qa, M, 0, w, b, y, ldy, accumulate);
    return;
  }
  for (; b < b1; b++) {
    int m = 0;
    for (; m + 2 <= M; m += 2) q4_block<2, 1>(qa, M, m, w, b, y, ldy, accumulate);
    if (m < M) q4_block<1, 1>(qa, M, m, w, b, y, ldy, accumulate);
  }
}

// ---- float32 GEMM: MR x 16 microkernel over half panels ----------------------------------

constexpr int MR = 6;
constexpr int KC = 256;

// Twelve named accumulators: as arrays GCC spilled them to the stack every k step.
#define PK_ROWS(X) X(0) X(1) X(2) X(3) X(4) X(5)

// The C tile starts from C (load), the bias or zero, or C plus the bias; ELU goes on as it is stored.
template <int R>
void ukernel(const float* A, int lda, int kc, const float* B, float* C, int ldc, const float* bias, bool load, bool elu) {
  __m256 c00, c01, c10, c11, c20, c21, c30, c31, c40, c41, c50, c51;
#define INIT(r)                                                 \
  if constexpr (R > r) {                                        \
    if (load) {                                                 \
      c##r##0 = _mm256_loadu_ps(C + size_t(r) * ldc);           \
      c##r##1 = _mm256_loadu_ps(C + size_t(r) * ldc + 8);       \
      if (bias) {                                               \
        c##r##0 = _mm256_add_ps(c##r##0, _mm256_loadu_ps(bias));     \
        c##r##1 = _mm256_add_ps(c##r##1, _mm256_loadu_ps(bias + 8)); \
      }                                                         \
    } else if (bias) {                                          \
      c##r##0 = _mm256_loadu_ps(bias);                          \
      c##r##1 = _mm256_loadu_ps(bias + 8);                      \
    } else {                                                    \
      c##r##0 = c##r##1 = _mm256_setzero_ps();                  \
    }                                                           \
  }
  PK_ROWS(INIT)
#undef INIT
  const float* a = A;
  for (int k = 0; k < kc; k++, a++) {
    const __m256 b0 = _mm256_load_ps(B + size_t(k) * 32), b1 = _mm256_load_ps(B + size_t(k) * 32 + 8);
#define FMA(r)                                                  \
  if constexpr (R > r) {                                        \
    const __m256 x = _mm256_broadcast_ss(a + size_t(r) * lda);  \
    c##r##0 = _mm256_fmadd_ps(x, b0, c##r##0);                  \
    c##r##1 = _mm256_fmadd_ps(x, b1, c##r##1);                  \
  }
    PK_ROWS(FMA)
#undef FMA
  }
#define ELU(r)                                                  \
  if constexpr (R > r) {                                        \
    c##r##0 = elu_ps(c##r##0);                                  \
    c##r##1 = elu_ps(c##r##1);                                  \
  }
  if (elu) {
    PK_ROWS(ELU)
  }
#undef ELU
#define STORE(r)                                                \
  if constexpr (R > r) {                                        \
    _mm256_storeu_ps(C + size_t(r) * ldc, c##r##0);             \
    _mm256_storeu_ps(C + size_t(r) * ldc + 8, c##r##1);         \
  }
  PK_ROWS(STORE)
#undef STORE
}
#undef PK_ROWS

using UK = void (*)(const float*, int, int, const float*, float*, int, const float*, bool, bool);
constexpr UK kUK[MR + 1] = {nullptr, ukernel<1>, ukernel<2>, ukernel<3>, ukernel<4>, ukernel<5>, ukernel<6>};

constexpr size_t kCachedB = 256 * 1024;  // bytes of B that stay in L2 while a row tile passes

void f32_gemm(const float* A, int lda, int M, int K, const float* panels, const float* bias, int n0, int n1,
              float* C, int ldc, int flags) {
  const bool acc = flags & kAccumulate, elu = flags & kElu;
  auto tile = [&](int m, int n, int k0) {
    const int kc = K - k0 < KC ? K - k0 : KC;
    kUK[M - m < MR ? M - m : MR](A + size_t(m) * lda + k0, lda, kc,
                                 panels + size_t(n / 32) * K * 32 + size_t(k0) * 32 + (n % 32),
                                 C + size_t(m) * ldc + n, ldc, k0 == 0 && bias ? bias + n : nullptr, acc || k0 > 0,
                                 elu && k0 + kc == K);
  };
  if (size_t(K) * (n1 - n0) * 4 <= kCachedB) {  // B stays in cache: rows outer, so A and C pass once
    for (int m = 0; m < M; m += MR)
      for (int k0 = 0; k0 < K; k0 += KC)
        for (int n = n0; n < n1; n += 16) tile(m, n, k0);
  } else {  // B streams: a K block of a column strip stays in L1 while every row passes
    for (int k0 = 0; k0 < K; k0 += KC)
      for (int n = n0; n < n1; n += 16)
        for (int m = 0; m < M; m += MR) tile(m, n, k0);
  }
}

void attn_f16(const float* q, const uint16_t* K, const uint16_t* V, int n, int D, float* out, float* scores) {
  const int nb = (n + 15) / 16;
  int b = 0;
  for (; b + 2 <= nb; b += 2) {
    __m256 a0 = _mm256_setzero_ps(), a1 = a0, a2 = a0, a3 = a0;
    const uint16_t* k0 = K + size_t(b) * D * 16;
    const uint16_t* k1 = k0 + size_t(D) * 16;
    for (int d = 0; d < D; d += 2) _mm_prefetch((const char*)(k0 + size_t(D) * 32 + d * 16), _MM_HINT_T0);  // the next pair
    for (int d = 0; d < D; d++) {
      __m256 qd = _mm256_broadcast_ss(q + d);
      a0 = _mm256_fmadd_ps(qd, _mm256_cvtph_ps(_mm_loadu_si128((const __m128i*)(k0 + d * 16))), a0);
      a1 = _mm256_fmadd_ps(qd, _mm256_cvtph_ps(_mm_loadu_si128((const __m128i*)(k0 + d * 16 + 8))), a1);
      a2 = _mm256_fmadd_ps(qd, _mm256_cvtph_ps(_mm_loadu_si128((const __m128i*)(k1 + d * 16))), a2);
      a3 = _mm256_fmadd_ps(qd, _mm256_cvtph_ps(_mm_loadu_si128((const __m128i*)(k1 + d * 16 + 8))), a3);
    }
    _mm256_storeu_ps(scores + b * 16, a0);
    _mm256_storeu_ps(scores + b * 16 + 8, a1);
    _mm256_storeu_ps(scores + b * 16 + 16, a2);
    _mm256_storeu_ps(scores + b * 16 + 24, a3);
  }
  for (; b < nb; b++) {
    __m256 a0 = _mm256_setzero_ps(), a1 = a0;
    const uint16_t* k0 = K + size_t(b) * D * 16;
    for (int d = 0; d < D; d++) {
      __m256 qd = _mm256_broadcast_ss(q + d);
      a0 = _mm256_fmadd_ps(qd, _mm256_cvtph_ps(_mm_loadu_si128((const __m128i*)(k0 + d * 16))), a0);
      a1 = _mm256_fmadd_ps(qd, _mm256_cvtph_ps(_mm_loadu_si128((const __m128i*)(k0 + d * 16 + 8))), a1);
    }
    _mm256_storeu_ps(scores + b * 16, a0);
    _mm256_storeu_ps(scores + b * 16 + 8, a1);
  }
  const float sum = softmax_exp(scores, n);
  const int dv = D / 8;  // <= 8
  __m256 acc[8];
  for (int j = 0; j < 8; j++) acc[j] = _mm256_setzero_ps();
  for (int t = 0; t < n; t++) {
    __m256 p = _mm256_broadcast_ss(scores + t);
    const uint16_t* v = V + size_t(t) * D;
    _mm_prefetch((const char*)(v + size_t(D) * 8), _MM_HINT_T0);
    for (int j = 0; j < dv; j++) acc[j] = _mm256_fmadd_ps(p, _mm256_cvtph_ps(_mm_loadu_si128((const __m128i*)(v + j * 8))), acc[j]);
  }
  __m256 inv = _mm256_set1_ps(1.0f / sum);
  for (int j = 0; j < dv; j++) _mm256_storeu_ps(out + j * 8, _mm256_mul_ps(acc[j], inv));
}

#ifdef __AVXVNNI__
constexpr const char* kName = "avxvnni";
constexpr int kFastBits = 8;
#else
constexpr const char* kName = "avx2";
constexpr int kFastBits = 7;
#endif

const Kernels kTable = {
    kName,
    {qact_bytes, quantize, q8_gemm},
    {qact_bytes_u8, quantize_u8, q8u_gemm},
    kFastBits,
    {qact_bytes4, quantize4, q4_gemm},
    f32_gemm, attn_f16, layernorm, gelu_tanh, silu, elu, softmax_exp, f32_to_f16, dot, hadamard,
    nullptr, nullptr, nullptr,
};

}  // namespace

#ifdef __AVXVNNI__
const Kernels& kernels_avxvnni() { return kTable; }
#else
const Kernels& kernels_avx2() { return kTable; }
#endif

}  // namespace pk
