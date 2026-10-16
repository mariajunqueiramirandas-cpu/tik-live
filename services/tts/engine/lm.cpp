#include "lm.h"

#include "prof.h"

#include <cmath>

namespace pk {

namespace {

// fp32 -> fp16 for a few scalars, through the kernel's vector conversion
inline void store_k(const Kernels& k, const float* src, int Dh, uint16_t* blk, int lane) {
  uint16_t tmp[64];
  k.f32_to_f16(src, Dh, tmp);
  for (int d = 0; d < Dh; d++) blk[d * 16 + lane] = tmp[d];
}

}  // namespace

LM::LM(const Config& c, const LMWeights& w, const Kernels& k, Pool& pool, int max_rows, int max_pos)
    : c_(c), w_(w), k_(k), pool_(pool), max_rows_(max_rows), max_pos_((max_pos + 15) & ~15) {
  const int D = c.d_model, Dh = c.head_dim(), F = c.flow_dim;
  // RoPE as pocket-tts computes it: frequencies and angles in float32
  cos_.resize(size_t(max_pos_) * Dh / 2);
  sin_.resize(size_t(max_pos_) * Dh / 2);
  for (int i = 0; i < Dh / 2; i++) {
    const float freq = std::exp(float(i) * float(-std::log(double(c.max_period)) * 2.0 / Dh));
    for (int p = 0; p < max_pos_; p++) {
      const float a = float(p) * freq;
      cos_[size_t(p) * Dh / 2 + i] = std::cos(a);
      sin_[size_t(p) * Dh / 2 + i] = std::sin(a);
    }
  }
  const int R = max_rows;
  h_.resize(size_t(R) * D);
  qkv_.resize(size_t(R) * 3 * D);
  att_.resize(size_t(R) * D);
  f_.resize(size_t(R) * (c.ff > 3 * D ? c.ff : 3 * D));
  scores_.resize(size_t(R) * c.heads * max_pos_);
  mods_.resize(size_t(R) * (3 * c.flow_depth + 2) * F);
  y_.resize(size_t(R) * F);
  xh_.resize(size_t(R) * F);
  t_.resize(size_t(R) * F);
  const int Kmax = c.ff > D ? c.ff : D;
  qa_.resize(std::max(k.q8.qact_bytes(R, Kmax), k.q4.qact_bytes(R, Kmax)));
  vk_.resize(w.voices.size());
  vv_.resize(w.voices.size());
}

void LM::linear(const Linear& l, const float* x, int ldx, int M, float* y, int ldy, bool accumulate) {
  const int N = l.N();
  if (l.q4) {
    k_.q4.quantize(x, ldx, M, l.w4.K, l.w4.r, qa_.data());
    const int step = 64, tasks = (N + step - 1) / step;
    const int per = (tasks + pool_.size() - 1) / pool_.size();
    const int jobs = (tasks + per - 1) / per;
    pool_.run(jobs, [&](int j) {
      const int n0 = j * per * step, n1 = std::min(N, (j + 1) * per * step);
      k_.q4.gemm(qa_.data(), M, l.w4, n0, n1, y, ldy, accumulate);
    });
  } else if (l.q8) {
    k_.q8.quantize(x, ldx, M, l.q.K, l.q.r, qa_.data());
    // column slices of 64 (four 16-row VNNI blocks), spread over the pool
    const int step = 64, tasks = (N + step - 1) / step;
    const int per = (tasks + pool_.size() - 1) / pool_.size();
    const int jobs = (tasks + per - 1) / per;
    pool_.run(jobs, [&](int j) {
      const int n0 = j * per * step, n1 = std::min(N, (j + 1) * per * step);
      k_.q8.gemm(qa_.data(), M, l.q, n0, n1, y, ldy, accumulate);
    });
  } else {
    const int panels = N / 32;
    const int per = (panels + pool_.size() - 1) / pool_.size();
    const int jobs = (panels + per - 1) / per;
    pool_.run(jobs, [&](int j) {
      const int n0 = j * per * 32, n1 = std::min(N, (j + 1) * per * 32);
      k_.f32_gemm(x, ldx, M, l.f.K, l.f.p, l.f.b, n0, n1, y, ldy, accumulate);
    });
  }
}

void LM::rope(float* v, int pos) const {
  const int Dh = c_.head_dim(), half = Dh / 2;
  const float* cs = cos_.p + size_t(pos) * half;
  const float* sn = sin_.p + size_t(pos) * half;
  for (int h = 0; h < c_.heads; h++) {
    float* x = v + h * Dh;
    for (int i = 0; i < half; i++) {
      const float a = x[2 * i], b = x[2 * i + 1];
      x[2 * i] = a * cs[i] - b * sn[i];
      x[2 * i + 1] = a * sn[i] + b * cs[i];
    }
  }
}

const uint16_t* LM::voice_template(int voice, bool keys) {
  std::lock_guard<std::mutex> g(voice_mu_);
  if (!vk_[voice].p) {
    const Voice& vo = w_.voices[voice];
    const int L = c_.layers, H = c_.heads, Dh = c_.head_dim(), D = c_.d_model;
    const int nb = (vo.len + 15) / 16;
    Buf<uint16_t> K(size_t(L) * H * nb * Dh * 16), V(size_t(L) * H * vo.len * Dh);
    K.zero();
    for (int l = 0; l < L; l++)
      for (int t = 0; t < vo.len; t++) {
        const uint16_t* ks = vo.kv + ((size_t(l) * 2 + 0) * vo.len + t) * D;
        const uint16_t* vs = vo.kv + ((size_t(l) * 2 + 1) * vo.len + t) * D;
        for (int h = 0; h < H; h++) {
          uint16_t* kb = K.p + ((size_t(l) * H + h) * nb + t / 16) * Dh * 16;
          for (int d = 0; d < Dh; d++) kb[d * 16 + t % 16] = ks[h * Dh + d];
          std::memcpy(V.p + ((size_t(l) * H + h) * vo.len + t) * Dh, vs + h * Dh, Dh * 2);
        }
      }
    vk_[voice] = std::move(K);
    vv_[voice] = std::move(V);
  }
  return keys ? vk_[voice].p : vv_[voice].p;
}

void LM::start(KVCache& kv, int voice, int extra) {
  const Voice& vo = w_.voices[voice];
  const int L = c_.layers, H = c_.heads, Dh = c_.head_dim();
  const int cap = (vo.len + extra + 15) & ~15;
  if (cap > max_pos_) throw std::runtime_error("sequence longer than the engine's position limit");
  kv.cap = cap;
  kv.len = vo.len;
  kv.k.resize(size_t(L) * H * cap * Dh);
  kv.v.resize(size_t(L) * H * cap * Dh);
  const uint16_t* K = voice_template(voice, true);
  const uint16_t* V = voice_template(voice, false);
  const int nb = (vo.len + 15) / 16;
  for (int lh = 0; lh < L * H; lh++) {
    std::memcpy(kv.k.p + size_t(lh) * cap * Dh, K + size_t(lh) * nb * Dh * 16, size_t(nb) * Dh * 16 * 2);
    std::memcpy(kv.v.p + size_t(lh) * cap * Dh, V + size_t(lh) * vo.len * Dh, size_t(vo.len) * Dh * 2);
  }
}

void LM::embed_tokens(const int32_t* tok, int n, float* x) const {
  const int D = c_.d_model;
  for (int i = 0; i < n; i++) {
    int t = tok[i] < 0 || tok[i] >= c_.vocab ? c_.vocab - 1 : tok[i];
    std::memcpy(x + size_t(i) * D, w_.lut + size_t(t) * D, size_t(D) * 4);
  }
}

void LM::embed_latents(int B, const float* const* lat, float* x) {
  const int L = c_.ldim;
  float* in = t_.p;  // [B][ldim]
  for (int b = 0; b < B; b++) std::memcpy(in + size_t(b) * L, lat[b] ? lat[b] : w_.bos, size_t(L) * 4);
  k_.f32_gemm(in, L, B, L, w_.in.p, nullptr, 0, c_.d_model, x, c_.d_model, false);
}

void LM::forward(int R, const Row* rows, float* x, const int* outs, int n_out, float* c) {
  const int D = c_.d_model, H = c_.heads, Dh = c_.head_dim(), D3 = 3 * D;
  for (int l = 0; l < c_.layers; l++) {
    const LMLayer& w = w_.layers[l];
    {
      PROF("lm.ln");
      for (int r = 0; r < R; r++) k_.layernorm(x + size_t(r) * D, D, w.n1w, w.n1b, 1e-5f, h_.p + size_t(r) * D);
    }
    {
      PROF("lm.qkv");
      linear(w.qkv, h_.p, D, R, qkv_.p, D3, false);
    }
    // rotate, then store every row's key and value before any row attends (prefill rows of one
    // sequence see each other)
    for (int r = 0; r < R; r++) {
      PROF("lm.rope_kv");
      float* q = qkv_.p + size_t(r) * D3;
      const int pos = rows[r].pos;
      rope(q, pos);
      rope(q + D, pos);
      KVCache& kv = *rows[r].kv;
      const int nb = kv.cap / 16;
      for (int h = 0; h < H; h++) {
        uint16_t* kb = kv.k.p + ((size_t(l) * H + h) * nb + pos / 16) * Dh * 16;
        store_k(k_, q + D + h * Dh, Dh, kb, pos % 16);
        k_.f32_to_f16(q + 2 * D + h * Dh, Dh, kv.v.p + ((size_t(l) * H + h) * kv.cap + pos) * Dh);
      }
    }
    {
      PROF("lm.attn");
      pool_.run(R * H, [&](int i) {
        const int r = i / H, h = i % H;
        const KVCache& kv = *rows[r].kv;
        const size_t lh = size_t(l) * H + h;
        k_.attn_f16(qkv_.p + size_t(r) * D3 + h * Dh, kv.k.p + lh * kv.cap * Dh, kv.v.p + lh * kv.cap * Dh,
                    rows[r].pos + 1, Dh, att_.p + size_t(r) * D + h * Dh, scores_.p + size_t(i) * max_pos_);
      });
    }
    {
      PROF("lm.o");
      linear(w.o, att_.p, D, R, x, D, true);
    }
    {
      PROF("lm.ln");
      for (int r = 0; r < R; r++) k_.layernorm(x + size_t(r) * D, D, w.n2w, w.n2b, 1e-5f, h_.p + size_t(r) * D);
    }
    {
      PROF("lm.ff1");
      linear(w.ff1, h_.p, D, R, f_.p, c_.ff, false);
    }
    {
      PROF("lm.gelu");
      pool_.run(R, [&](int r) { k_.gelu_tanh(f_.p + size_t(r) * c_.ff, c_.ff); });
    }
    {
      PROF("lm.ff2");
      linear(w.ff2, f_.p, c_.ff, R, x, D, true);
    }
  }
  for (int i = 0; i < n_out; i++) k_.layernorm(x + size_t(outs[i]) * D, D, w_.onw, w_.onb, 1e-5f, c + size_t(i) * D);
}

void LM::head(int B, const float* c, const float* noise, float* latent, float* eos) {
  PROF("lm.head");
  const int D = c_.d_model, F = c_.flow_dim, L = c_.ldim, depth = c_.flow_depth;
  const int MW = (3 * depth + 2) * F;
  for (int b = 0; b < B; b++) eos[b] = k_.dot(c + size_t(b) * D, w_.eosw, D) + w_.eosb;
  linear(w_.cond, c, D, B, y_.p, F, false);
  for (int b = 0; b < B; b++) k_.silu(y_.p + size_t(b) * F, F);
  linear(w_.ada, y_.p, F, B, mods_.p, MW, false);
  k_.f32_gemm(noise, L, B, L, w_.fin.p, w_.fin.b, 0, F, xh_.p, F, false);
  for (int i = 0; i < depth; i++) {
    const FlowBlock& fb = w_.blocks[i];
    for (int b = 0; b < B; b++) {
      const float* m = mods_.p + size_t(b) * MW + size_t(i) * 3 * F;
      float* h = h_.p + size_t(b) * F;
      k_.layernorm(xh_.p + size_t(b) * F, F, fb.lnw, fb.lnb, 1e-6f, h);
      for (int j = 0; j < F; j++) h[j] = h[j] * (1.0f + m[F + j]) + m[j];
    }
    linear(fb.m0, h_.p, F, B, t_.p, F, false);
    for (int b = 0; b < B; b++) k_.silu(t_.p + size_t(b) * F, F);
    linear(fb.m2, t_.p, F, B, y_.p, F, false);
    for (int b = 0; b < B; b++) {
      const float* gate = mods_.p + size_t(b) * MW + size_t(i) * 3 * F + 2 * F;
      float* xh = xh_.p + size_t(b) * F;
      const float* u = y_.p + size_t(b) * F;
      for (int j = 0; j < F; j++) xh[j] += gate[j] * u[j];
    }
  }
  for (int b = 0; b < B; b++) {
    const float* m = mods_.p + size_t(b) * MW + size_t(depth) * 3 * F;
    float* h = h_.p + size_t(b) * F;
    k_.layernorm(xh_.p + size_t(b) * F, F, nullptr, nullptr, 1e-6f, h);
    for (int j = 0; j < F; j++) h[j] = h[j] * (1.0f + m[F + j]) + m[j];
  }
  k_.f32_gemm(h_.p, F, B, F, w_.fout.p, w_.fout.b, 0, L, latent, L, false);
  for (int b = 0; b < B; b++)
    for (int j = 0; j < L; j++) latent[size_t(b) * L + j] += noise[size_t(b) * L + j];
}

}  // namespace pk
