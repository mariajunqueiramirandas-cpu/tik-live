// AMX kernels (AMX-TILE, AMX-BF16, AVX512-BF16) on top of the AVX-512 table. Built with those
// flags; called only when cpuid has them and the kernel granted this process the tile state.
#include <immintrin.h>
#include <sys/syscall.h>

#include <cmath>
#include <unistd.h>

#include "internal.h"
#include "vmath512.h"

namespace pk {
namespace {

struct TileConfig {
  uint8_t palette = 1, start_row = 0;
  uint8_t reserved[14] = {};
  uint16_t colsb[16] = {};
  uint8_t rows[16] = {};
};

// Every tile is 16 rows of 64 bytes: C 16x16 float32, A 16x32 bf16, B 16 pairs x 16 columns.
// Tile state is per thread; the pool's workers configure on their first call.
inline void configure() {
  static thread_local bool done = false;
  if (done) return;
  TileConfig c;
  for (int i = 0; i < 8; i++) c.colsb[i] = 64, c.rows[i] = 16;
  _tile_loadconfig(&c);
  done = true;
}

// C tiles 0..3 (rows m, m+16 x columns n, n+16), A tiles 4, 5, B tiles 6, 7. RM row tiles (1 or 2)
// by CN column tiles (1 or 2).
template <int RM, int CN>
void block(const uint16_t* A, int lda, int K, const uint16_t* B, const float* bias, float* C, int ldc, bool load) {
  const size_t sa = size_t(lda) * 2, sc = size_t(ldc) * 4, bstride = size_t(K) * 16;  // B: next column tile
  if (load) {
    if (bias)  // added to the loaded C, as the float32 kernels do
      for (int r = 0; r < 16 * RM; r++)
        for (int j = 0; j < 16 * CN; j += 16) {
          float* c = C + size_t(r) * ldc + j;
          _mm512_storeu_ps(c, _mm512_add_ps(_mm512_loadu_ps(c), _mm512_loadu_ps(bias + j)));
        }
    _tile_loadd(0, C, sc);
    if (CN > 1) _tile_loadd(1, C + 16, sc);
    if (RM > 1) _tile_loadd(2, C + 16 * size_t(ldc), sc);
    if (RM > 1 && CN > 1) _tile_loadd(3, C + 16 * size_t(ldc) + 16, sc);
  } else if (bias) {  // stride 0: every row is the bias
    _tile_loadd(0, bias, 0);
    if (CN > 1) _tile_loadd(1, bias + 16, 0);
    if (RM > 1) _tile_loadd(2, bias, 0);
    if (RM > 1 && CN > 1) _tile_loadd(3, bias + 16, 0);
  } else {
    _tile_zero(0);
    if (CN > 1) _tile_zero(1);
    if (RM > 1) _tile_zero(2);
    if (RM > 1 && CN > 1) _tile_zero(3);
  }
  for (int k = 0; k < K; k += 32) {
    _tile_loadd(4, A + k, sa);
    if (RM > 1) _tile_loadd(5, A + 16 * size_t(lda) + k, sa);
    _tile_loadd(6, B + size_t(k) * 16, 64);
    if (CN > 1) _tile_loadd(7, B + bstride + size_t(k) * 16, 64);
    _tile_dpbf16ps(0, 4, 6);
    if (CN > 1) _tile_dpbf16ps(1, 4, 7);
    if (RM > 1) _tile_dpbf16ps(2, 5, 6);
    if (RM > 1 && CN > 1) _tile_dpbf16ps(3, 5, 7);
  }
  _tile_stored(0, C, sc);
  if (CN > 1) _tile_stored(1, C + 16, sc);
  if (RM > 1) _tile_stored(2, C + 16 * size_t(ldc), sc);
  if (RM > 1 && CN > 1) _tile_stored(3, C + 16 * size_t(ldc) + 16, sc);
}

void bf16_gemm(const uint16_t* A, int lda, int M, int K, const BW& w, int n0, int n1, float* C, int ldc,
               bool accumulate) {
  configure();
  for (int n = n0; n < n1; n += 32) {
    const uint16_t* B = w.w + size_t(n / 16) * K * 16;
    const float* bias = w.b ? w.b + n : nullptr;
    const bool two = n1 - n >= 32;
    for (int m = 0; m < M; m += 32) {
      const uint16_t* a = A + size_t(m) * lda;
      float* c = C + size_t(m) * ldc + n;
      if (M - m >= 32)
        two ? block<2, 2>(a, lda, K, B, bias, c, ldc, accumulate) : block<2, 1>(a, lda, K, B, bias, c, ldc, accumulate);
      else
        two ? block<1, 2>(a, lda, K, B, bias, c, ldc, accumulate) : block<1, 1>(a, lda, K, B, bias, c, ldc, accumulate);
    }
  }
}

void to_bf16(const float* x, int n, uint16_t* y) {
  int i = 0;
  for (; i + 32 <= n; i += 32) {
    __m512bh v = _mm512_cvtne2ps_pbh(_mm512_loadu_ps(x + i + 16), _mm512_loadu_ps(x + i));
    _mm512_storeu_si512((void*)(y + i), (__m512i)v);
  }
  for (; i < n; i++) y[i] = bf16_rne(x[i]);
}

void elu_bf16(const float* x, int n, uint16_t* y) {
  int i = 0;
  for (; i + 32 <= n; i += 32) {
    __m512bh v = _mm512_cvtne2ps_pbh(elu_ps(_mm512_loadu_ps(x + i + 16)), elu_ps(_mm512_loadu_ps(x + i)));
    _mm512_storeu_si512((void*)(y + i), (__m512i)v);
  }
  for (; i < n; i++) y[i] = bf16_rne(x[i] < 0 ? std::expm1(x[i]) : x[i]);
}

}  // namespace

bool amx_enable() {
  constexpr long kReqXcompPerm = 0x1023, kXtileData = 18;
  return syscall(SYS_arch_prctl, kReqXcompPerm, kXtileData) == 0;
}

const Kernels& kernels_amx() {
  static const Kernels t = [] {
    Kernels k = kernels_avx512();
    k.name = "amx";
    k.bf16_gemm = bf16_gemm;
    k.to_bf16 = to_bf16;
    k.elu_bf16 = elu_bf16;
    return k;
  }();
  return t;
}

}  // namespace pk
