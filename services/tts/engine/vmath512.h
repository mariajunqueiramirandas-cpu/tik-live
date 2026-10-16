// AVX-512 vector math shared by the kernel files built with AVX-512 flags (and only those).
#pragma once

#include <immintrin.h>

namespace pk {
namespace {

// exp with Cephes' expf polynomial, ~1 ulp on [-87, 88].
inline __m512 exp_ps(__m512 x) {
  x = _mm512_min_ps(_mm512_max_ps(x, _mm512_set1_ps(-87.3f)), _mm512_set1_ps(88.7f));
  __m512 n = _mm512_roundscale_ps(_mm512_mul_ps(x, _mm512_set1_ps(1.44269504088896341f)),
                                  _MM_FROUND_TO_NEAREST_INT | _MM_FROUND_NO_EXC);
  __m512 r = _mm512_fnmadd_ps(n, _mm512_set1_ps(0.693359375f), x);
  r = _mm512_fnmadd_ps(n, _mm512_set1_ps(-2.12194440e-4f), r);
  __m512 p = _mm512_set1_ps(1.9875691500E-4f);
  p = _mm512_fmadd_ps(p, r, _mm512_set1_ps(1.3981999507E-3f));
  p = _mm512_fmadd_ps(p, r, _mm512_set1_ps(8.3334519073E-3f));
  p = _mm512_fmadd_ps(p, r, _mm512_set1_ps(4.1665795894E-2f));
  p = _mm512_fmadd_ps(p, r, _mm512_set1_ps(1.6666665459E-1f));
  p = _mm512_fmadd_ps(p, r, _mm512_set1_ps(5.0000001201E-1f));
  __m512 y = _mm512_fmadd_ps(p, _mm512_mul_ps(r, r), _mm512_add_ps(r, _mm512_set1_ps(1.0f)));
  return _mm512_scalef_ps(y, n);
}

inline __m512 elu_ps(__m512 x) {
  __m512 e = _mm512_sub_ps(exp_ps(_mm512_min_ps(x, _mm512_setzero_ps())), _mm512_set1_ps(1.0f));
  __mmask16 pos = _mm512_cmp_ps_mask(x, _mm512_setzero_ps(), _CMP_GT_OQ);
  return _mm512_mask_blend_ps(pos, e, x);
}

}  // namespace
}  // namespace pk
