#include "mimi.h"

#include "prof.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace pk {

Mimi::Mimi(const Config& c, const MimiWeights& w, const Kernels& k, Pool& pool, int max_chunk, int max_frames)
    : c_(c), w_(w), k_(k), pool_(pool), amx_(k.bf16_gemm != nullptr), max_chunk_(max_chunk), W_(c.m_context),
      d_(std::make_shared<Derived>()) {
  const int Dh = c.m_head_dim();
  max_pos_ = (max_frames + max_chunk) * c.upsample;
  d_->cos.resize(size_t(max_pos_) * Dh / 2);
  d_->sin.resize(size_t(max_pos_) * Dh / 2);
  for (int i = 0; i < Dh / 2; i++) {
    const float freq = std::exp(float(i) * float(-std::log(double(c.m_max_period)) * 2.0 / Dh));
    for (int p = 0; p < max_pos_; p++) {
      const float a = float(p) * freq;
      d_->cos[size_t(p) * Dh / 2 + i] = std::cos(a);
      d_->sin[size_t(p) * Dh / 2 + i] = std::sin(a);
    }
  }
  init_scratch();
  if (amx_) {
    Bf16& bf = d_->bf;
    for (const MimiLayer& l : w.layers)
      bf.layers.push_back({to_bf16(l.qkv.f), to_bf16(l.o.f), to_bf16(l.ff1.f), to_bf16(l.ff2.f)});
    bf.c0 = to_bf16(w.c0.w.f);
    for (int j = 0; j < c.n_ratios; j++) {
      bf.ups.push_back(to_bf16(w.ups[j].w));
      bf.res.emplace_back();
      for (const ConvW& r : w.res[j]) bf.res.back().push_back(to_bf16(r.w.f));
    }
  } else {
    const bool f32 = w.c0.w.f.p != nullptr, q8 = w.c0.w.q8;
    if (q8 && (k.fast_wbits == 8 || f32)) {
      auto fast = [&](const Linear& l) { return k.fast_wbits == 8 ? l.q : to_q7(l.f); };
      for (const MimiLayer& l : w.layers)
        d_->fast.layers.push_back({fast(l.qkv), fast(l.o), fast(l.ff1), fast(l.ff2)});
      d_->fast.c0 = fast(w.c0.w);
    }
    choose_mode(f32, q8, !d_->fast.layers.empty());
  }
}

Mimi::Mimi(const Mimi& lead, Pool& pool)
    : c_(lead.c_), w_(lead.w_), k_(lead.k_), pool_(pool), amx_(lead.amx_), max_chunk_(lead.max_chunk_),
      max_pos_(lead.max_pos_), W_(lead.W_), d_(lead.d_) {
  init_scratch();
}

void Mimi::init_scratch() {
  const Config& c = c_;
  const int M = c.m_dim, H = c.m_heads, P = max_chunk_ * c.upsample;
  cap_ = (W_ - 1 + 31 + P + 31) & ~31;  // kept history (< hist + 32) plus a chunk
  smax_ = (kQB + W_ - 1 + 31 + 31) & ~31;
  lat_.resize(size_t(max_chunk_) * M);
  x_.resize(size_t(P) * M);
  h_.resize(size_t(P) * M);
  qkv_.resize(size_t(P) * 3 * M);
  att_.resize(size_t(P) * M);
  ff_.resize(size_t(P) * c.m_ff);
  s_.resize(size_t(H) * kQB * smax_);

  // conv input stages and their history slots; the output conv is a float32 dot product
  auto add = [&](int hist, int ch, int rows, bool bf16) {
    Stage st;
    st.hist = hist, st.ch = ch, st.esz = bf16 ? 2 : 4, st.off = hist_size_;
    st.buf.resize(size_t(hist + rows) * ch * st.esz);
    hist_size_ += size_t(hist) * ch * st.esz;
    stages_.push_back(std::move(st));
  };
  add(c.kernel - 1, M, P, amx_);
  int rows = P, ch = w_.c0.cout;
  y_.emplace_back(size_t(P) * ch);
  size_t rh = 0;
  for (int j = 0; j < c.n_ratios; j++) {
    const ConvTrW& u = w_.ups[j];
    add(1, u.cin, rows, amx_);
    rows *= u.s;
    ch = u.cout;
    y_.emplace_back(size_t(rows) * ch);
    for (int r = 0; r < c.n_residual; r++) {
      add(c.res_kernel - 1, ch, rows, amx_);
      rh = std::max(rh, size_t(rows) * w_.res[j][2 * r].cout);
    }
  }
  add(c.last_kernel - 1, ch, rows, false);
  rh_.resize(rh);
  if (amx_) {
    rhb_.resize(rh);
    xb_.resize(size_t(P) * std::max(M, c.m_ff));
  } else {
    const int T = pool_.size(), kmax = std::max({M, c.m_ff, c.kernel * M});
    qa_rows_ = std::max(8, ((P + T - 1) / T + 7) / 8 * 8);
    qa_slot_ = (std::max(k_.q8.qact_bytes(qa_rows_, kmax), k_.q8_fast.qact_bytes(qa_rows_, kmax)) + 63) & ~size_t(63);
    qa_.resize(qa_slot_ * ((P + qa_rows_ - 1) / qa_rows_));
  }
}

// The transformer's and c0's matrices without AMX: times the largest one each way on a full chunk
// and keeps the most precise mode within 10% of the fastest. PK_MIMI_MODE=f32|q12|q8 forces one.
void Mimi::choose_mode(bool f32, bool q12, bool q8) {
  const char* names[] = {"f32", "q12", "q8"};
  const bool ok[] = {f32, q12, q8};
  if (const char* env = std::getenv("PK_MIMI_MODE")) {
    for (int i = 0; i < 3; i++)
      if (std::string(env) == names[i] && ok[i]) return void(d_->mode = Mode(i));
    throw std::runtime_error(std::string("PK_MIMI_MODE=") + env + " is unknown or unavailable");
  }
  const int P = max_chunk_ * c_.upsample, M = c_.m_dim;
  for (int i = 0; i < P * M; i++) h_.p[i] = std::sin(0.37f * float(i));
  double t[3] = {1e30, 1e30, 1e30};
  for (int i = 0; i < 3; i++) {
    if (!ok[i]) continue;
    d_->mode = Mode(i);
    for (int r = 0; r < 4; r++) {
      const auto t0 = std::chrono::steady_clock::now();
      linear(0, 2, h_.p, P, ff_.p, c_.m_ff, false);
      const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
      if (r) t[i] = std::min(t[i], dt);  // the first run warms up
    }
  }
  const double best = std::min({t[0], t[1], t[2]});
  for (int i = 0; i < 3; i++)
    if (t[i] <= best * 1.1) return void(d_->mode = Mode(i));
}

BW Mimi::to_bf16(const PW& w) {
  if (!w.p) throw std::runtime_error("the model file lacks the decoder's float32 weights");
  if (w.N % 16 || w.K % 32) throw std::runtime_error("decoder matrix shape unfit for AMX");
  uint16_t* b = own<uint16_t>(size_t(w.N) * w.K);
  for (int n = 0; n < w.N; n++) {
    const float* src = w.p + size_t(n / 32) * w.K * 32 + n % 32;  // panels [N/32][K][32]
    uint16_t* dst = b + size_t(n / 16) * w.K * 16 + (n % 16) * 2;
    for (int k = 0; k < w.K; k++) dst[size_t(k / 2) * 32 + (k % 2)] = bf16_rne(src[size_t(k) * 32]);
  }
  return BW{w.N, w.K, b, w.b};
}

QW Mimi::to_q7(const PW& w) {
  if (!w.p) throw std::runtime_error("the model file lacks the decoder's float32 weights");
  int8_t* q = own<int8_t>(size_t(w.N) * w.K);
  float* s = own<float>(w.N);
  int32_t* z = own<int32_t>(w.N);
  std::vector<float> row(w.K);
  for (int n = 0; n < w.N; n++) {
    float amax = 0;
    for (int k = 0; k < w.K; k++) {
      row[k] = w.p[size_t(n / 32) * w.K * 32 + size_t(k) * 32 + n % 32];
      amax = std::max(amax, std::fabs(row[k]));
    }
    s[n] = amax > 0 ? amax / 63.0f : 1.0f;
    z[n] = 0;
    for (int k = 0; k < w.K; k++) {
      const int v = int(std::clamp(std::nearbyint(row[k] / s[n]), -63.0f, 63.0f));
      q[(size_t(n / 16) * (w.K / 4) + k / 4) * 64 + (n % 16) * 4 + k % 4] = int8_t(v);
      z[n] += v;
    }
  }
  QW out;
  out.N = w.N, out.K = w.K, out.q = q, out.s = s, out.z = z, out.b = w.b;
  return out;
}

void Mimi::reset(MimiState& s) const {
  const int H = c_.m_heads, Dh = c_.m_head_dim();
  s.pos = 0;
  s.up_prev.resize(c_.m_dim);
  s.up_prev.zero();
  s.kbase = 0;
  s.kp.resize(size_t(c_.m_layers) * H * cap_ * Dh);
  s.vp.resize(size_t(c_.m_layers) * H * cap_ * Dh);
  s.kp.zero();
  s.vp.zero();
  s.hist.resize(hist_size_);
  s.hist.zero();
}

void Mimi::gemm(const PW& w, const float* A, int lda, int M, float* C, int ldc, int flags) {
  const int panels = w.N / 32, T = pool_.size();
  if (T == 1) {
    k_.f32_gemm(A, lda, M, w.K, w.p, w.b, 0, w.N, C, ldc, flags);
  } else if (panels >= T) {
    const int per = (panels + T - 1) / T, jobs = (panels + per - 1) / per;
    pool_.run(jobs, [&](int j) {
      k_.f32_gemm(A, lda, M, w.K, w.p, w.b, j * per * 32, std::min(w.N, (j + 1) * per * 32), C, ldc, flags);
    });
  } else {  // few columns: split rows instead, in multiples of 12 (the AVX-512 microkernel)
    const int per = ((M + T - 1) / T + 11) / 12 * 12, jobs = (M + per - 1) / per;
    pool_.run(jobs, [&](int j) {
      const int m0 = j * per, m = std::min(M - m0, per);
      k_.f32_gemm(A + size_t(m0) * lda, lda, m, w.K, w.p, w.b, 0, w.N, C + size_t(m0) * ldc, ldc, flags);
    });
  }
}

// Keys and values stay in MimiState as GEMM panels, K^T [cap/32][Dh][32] and V [Dh/32][cap][32],
// buffer index t holding position kbase + t. A chunk transposes only its own keys in, each block of
// kQB queries multiplies only the panels its window reaches, and the history then moves down by
// whole panels.
void Mimi::attend(MimiState& s, int l, int h, int P) {
  const int M = c_.m_dim, H = c_.m_heads, Dh = c_.m_head_dim(), M3 = 3 * M, hist = W_ - 1;
  const int pos0 = s.pos, t0 = pos0 - s.kbase;  // buffer index of the chunk's first key
  float* kp = s.kp.p + (size_t(l) * H + h) * cap_ * Dh;
  float* vp = s.vp.p + (size_t(l) * H + h) * cap_ * Dh;
  for (int i = 0; i < P; i++) {
    const float* r = qkv_.p + size_t(i) * M3 + h * Dh;
    const int t = t0 + i;
    float* kd = kp + size_t(t / 32) * Dh * 32 + t % 32;
    for (int d = 0; d < Dh; d++) kd[d * 32] = r[M + d];
    for (int q = 0; q < Dh / 32; q++) std::memcpy(vp + (size_t(q) * cap_ + t) * 32, r + 2 * M + q * 32, 128);
  }
  float* sc = s_.p + size_t(h) * kQB * smax_;
  for (int i0 = 0; i0 < P; i0 += kQB) {
    const int qb = std::min(kQB, P - i0);
    const int lp = (std::max(0, pos0 + i0 - hist) - s.kbase) & ~31;  // first panel the block reaches
    const int np = (t0 + i0 + qb - lp + 31) & ~31;
    k_.f32_gemm(qkv_.p + size_t(i0) * M3 + h * Dh, M3, qb, Dh, kp + size_t(lp) * Dh, nullptr, 0, np, sc, np, false);
    float inv[kQB];
    for (int r = 0; r < qb; r++) {
      float* row = sc + size_t(r) * np;
      const int q = pos0 + i0 + r;  // keys q-hist..q, past position 0
      const int lo = std::max(0, q - hist) - s.kbase - lp, hi = q - s.kbase - lp;
      inv[r] = 1.0f / k_.softmax_exp(row + lo, hi - lo + 1);
      std::fill(row, row + lo, 0.0f);
      std::fill(row + hi + 1, row + np, 0.0f);
    }
    float* out = att_.p + size_t(i0) * M + h * Dh;
    for (int q = 0; q < Dh / 32; q++)
      k_.f32_gemm(sc, np, qb, np, vp + (size_t(q) * cap_ + lp) * 32, nullptr, 0, 32, out + q * 32, M, false);
    for (int r = 0; r < qb; r++)
      for (int d = 0; d < Dh; d++) out[size_t(r) * M + d] *= inv[r];
  }
  const int keep = kept(s, P), n = t0 + P - keep;
  if (keep > 0) {
    std::memmove(kp, kp + size_t(keep) * Dh, size_t((n + 31) & ~31) * Dh * 4);
    for (int q = 0; q < Dh / 32; q++)
      std::memmove(vp + size_t(q) * cap_ * 32, vp + (size_t(q) * cap_ + keep) * 32, size_t(n) * 128);
  }
}

void Mimi::qgemm(const Q8& q, const QW& w, const float* A, int lda, int M, float* C, int ldc, bool accumulate) {
  // each job quantizes its rows and multiplies them by every column: no sync in between
  const int jobs = (M + qa_rows_ - 1) / qa_rows_;
  pool_.run(jobs, [&](int j) {
    const int m0 = j * qa_rows_, m = std::min(M - m0, qa_rows_);
    void* qa = qa_.p + j * qa_slot_;
    q.quantize(A + size_t(m0) * lda, lda, m, w.K, w.r, qa);
    q.gemm(qa, m, w, 0, w.N, C + size_t(m0) * ldc, ldc, accumulate);
  });
}

void Mimi::dense(const Linear& w, const QW& fast, const float* A, int lda, int M, float* C, int ldc, bool accumulate) {
  switch (d_->mode) {
    case Mode::kF32: return gemm(w.f, A, lda, M, C, ldc, accumulate);
    case Mode::kQ12: return qgemm(k_.q8, w.q, A, lda, M, C, ldc, accumulate);
    case Mode::kQ8: return qgemm(k_.q8_fast, fast, A, lda, M, C, ldc, accumulate);
  }
}

void Mimi::gemm(const BW& w, const uint16_t* A, int lda, int M, float* C, int ldc, bool accumulate) {
  const int panels = w.N / 32, T = pool_.size();
  if (T == 1) {
    k_.bf16_gemm(A, lda, M, w.K, w, 0, w.N, C, ldc, accumulate);
  } else if (panels >= T) {
    const int per = (panels + T - 1) / T, jobs = (panels + per - 1) / per;
    pool_.run(jobs, [&](int j) {
      k_.bf16_gemm(A, lda, M, w.K, w, j * per * 32, std::min(w.N, (j + 1) * per * 32), C, ldc, accumulate);
    });
  } else {  // few columns: split rows, in multiples of 32 (two tiles)
    const int per = ((M + T - 1) / T + 31) / 32 * 32, jobs = (M + per - 1) / per;
    pool_.run(jobs, [&](int j) {
      const int m0 = j * per, m = std::min(M - m0, per);
      k_.bf16_gemm(A + size_t(m0) * lda, lda, m, w.K, w, 0, w.N, C + size_t(m0) * ldc, ldc, accumulate);
    });
  }
}

void Mimi::linear(int l, int i, const float* x, int P, float* C, int ldc, bool accumulate) {
  const MimiLayer& w = w_.layers[l];
  const Linear& m = i == 0 ? w.qkv : i == 1 ? w.o : i == 2 ? w.ff1 : w.ff2;
  if (amx_) {
    const BW& b = d_->bf.layers[l][i];
    convert(x, size_t(P) * b.K, reinterpret_cast<uint8_t*>(xb_.p), 2, false);
    gemm(b, xb_.p, b.K, P, C, ldc, accumulate);
  } else {
    dense(m, d_->fast.layers[l][i], x, m.K(), P, C, ldc, accumulate);
  }
}

void Mimi::transformer(MimiState& s, float* x, int P) {
  const int M = c_.m_dim, H = c_.m_heads, Dh = c_.m_head_dim(), half = Dh / 2, M3 = 3 * M;
  const int pos0 = s.pos;
  if (pos0 + P > max_pos_) throw std::runtime_error("audio longer than the decoder's position limit");
  for (int l = 0; l < c_.m_layers; l++) {
    const MimiLayer& w = w_.layers[l];
    {
      PROF("mt.ln");
      for (int i = 0; i < P; i++) k_.layernorm(x + size_t(i) * M, M, w.n1w, w.n1b, 1e-5f, h_.p + size_t(i) * M);
    }
    {
      PROF("mt.qkv");
      linear(l, 0, h_.p, P, qkv_.p, M3, false);
    }
    {
      PROF("mt.rope");
      for (int i = 0; i < P; i++) {
        const float* cs = d_->cos.p + size_t(pos0 + i) * half;
        const float* sn = d_->sin.p + size_t(pos0 + i) * half;
        for (int part = 0; part < 2; part++) {
          float* v = qkv_.p + size_t(i) * M3 + part * M;
          for (int h = 0; h < H; h++)
            for (int j = 0; j < half; j++) {
              float* e = v + h * Dh + 2 * j;
              const float a = e[0], b = e[1];
              e[0] = a * cs[j] - b * sn[j];
              e[1] = a * sn[j] + b * cs[j];
            }
        }
      }
    }
    {
      PROF("mt.attn");
      pool_.run(H, [&](int h) { attend(s, l, h, P); });
    }
    {
      PROF("mt.o");
      linear(l, 1, att_.p, P, x, M, true);
    }
    {
      PROF("mt.ln");
      for (int i = 0; i < P; i++) k_.layernorm(x + size_t(i) * M, M, w.n2w, w.n2b, 1e-5f, h_.p + size_t(i) * M);
    }
    {
      PROF("mt.ff1");
      linear(l, 2, h_.p, P, ff_.p, c_.m_ff, false);
    }
    {
      PROF("mt.gelu");
      pool_.run(P, [&](int i) { k_.gelu_tanh(ff_.p + size_t(i) * c_.m_ff, c_.m_ff); });
    }
    {
      PROF("mt.ff2");
      linear(l, 3, ff_.p, P, x, M, true);
    }
  }
  s.kbase += kept(s, P);
  s.pos += P;
}

void Mimi::convert(const float* src, size_t n, uint8_t* dst, int esz, bool elu) {
  const int T = pool_.size();
  const size_t per = ((n + T - 1) / T + 31) & ~size_t(31);
  pool_.run(int((n + per - 1) / per), [&](int j) {
    const size_t a = j * per, m = std::min(n, a + per) - a;
    if (esz == 2)
      (elu ? k_.elu_bf16 : k_.to_bf16)(src + a, int(m), reinterpret_cast<uint16_t*>(dst) + a);
    else if (elu)
      k_.elu(src + a, int(m), reinterpret_cast<float*>(dst) + a);
    else
      std::memcpy(reinterpret_cast<float*>(dst) + a, src + a, m * 4);
  });
}

void Mimi::stage_in(MimiState& s, Stage& st, const float* src, int rows, bool elu) {
  PROF("m.stage_in");
  const size_t hb = size_t(st.hist) * st.ch * st.esz;
  std::memcpy(st.buf.p, s.hist.p + st.off, hb);
  convert(src, size_t(rows) * st.ch, st.buf.p + hb, st.esz, elu);
}

void Mimi::stage_save(MimiState& s, Stage& st, int rows) const {
  const size_t row = size_t(st.ch) * st.esz;
  std::memcpy(s.hist.p + st.off, st.buf.p + rows * row, st.hist * row);
}

void Mimi::decode(MimiState& s, const float* lat, int n, float* audio) {
  if (n < 1 || n > max_chunk_) throw std::runtime_error("bad chunk size");
  const int M = c_.m_dim, us = c_.upsample, P = n * us;
  float* x = x_.p;
  {  // latent projection and the depthwise transposed conv up to the transformer's rate
    PROF("m.in_up");
    k_.f32_gemm(lat, c_.ldim, n, c_.ldim, w_.in.p, w_.in.b, 0, M, lat_.p, M, false);
    for (int t = 0; t < n; t++) {
      const float* cur = lat_.p + size_t(t) * M;
      const float* prev = t ? cur - M : s.up_prev.p;
      for (int r = 0; r < us; r++) {
        const float* wc = w_.up + size_t(r) * M;
        const float* wp = w_.up + size_t(r + us) * M;
        float* o = x + size_t(t * us + r) * M;
        for (int ch = 0; ch < M; ch++) o[ch] = cur[ch] * wc[ch] + prev[ch] * wp[ch];
      }
    }
    std::memcpy(s.up_prev.p, lat_.p + size_t(n - 1) * M, size_t(M) * 4);
  }
  transformer(s, x, P);
  Stage& s0 = stages_[0];
  stage_in(s, s0, x, P, false);
  {
    PROF("m.c0");
    if (amx_)
      gemm(d_->bf.c0, s0.h(), M, P, y_[0].p, w_.c0.cout, false);
    else
      dense(w_.c0.w, d_->fast.c0, s0.f(), M, P, y_[0].p, w_.c0.cout, false);
  }
  stage_save(s, s0, P);
  int rows = P, si = 1;
  const float* prev = y_[0].p;
  for (int j = 0; j < c_.n_ratios; j++) {
    const ConvTrW& u = w_.ups[j];
    Stage& su = stages_[si++];
    stage_in(s, su, prev, rows, true);
    float* y = y_[j + 1].p;
    {
      PROF(j == 0 ? "m.up0" : j == 1 ? "m.up1" : "m.up2+");
      if (amx_)
        gemm(d_->bf.ups[j], su.h(), u.cin, rows, y, u.s * u.cout, false);
      else
        gemm(u.w, su.f(), u.cin, rows, y, u.s * u.cout, false);
    }
    stage_save(s, su, rows);
    rows *= u.s;
    for (int r = 0; r < c_.n_residual; r++) {
      const ConvW& a = w_.res[j][2 * r];
      const ConvW& b = w_.res[j][2 * r + 1];
      Stage& sr = stages_[si++];
      stage_in(s, sr, y, rows, true);
      PROF(j == 0 ? "m.res0" : j == 1 ? "m.res1" : "m.res2+");
      const size_t nh = size_t(rows) * a.cout;
      if (amx_) {
        gemm(d_->bf.res[j][2 * r], sr.h(), a.cin, rows, rh_.p, a.cout, false);
        convert(rh_.p, nh, reinterpret_cast<uint8_t*>(rhb_.p), 2, true);
        gemm(d_->bf.res[j][2 * r + 1], rhb_.p, b.cin, rows, y, b.cout, true);
      } else {
        gemm(a.w.f, sr.f(), a.cin, rows, rh_.p, a.cout, kElu);
        gemm(b.w.f, rh_.p, b.cin, rows, y, b.cout, kAccumulate);
      }
      stage_save(s, sr, rows);
    }
    prev = y;
  }
  Stage& sl = stages_[si];
  stage_in(s, sl, prev, rows, true);
  PROF("m.out");
  const int K = c_.last_kernel * sl.ch;
  const int T = pool_.size(), per = (rows + T - 1) / T;
  pool_.run(T, [&](int j) {
    const int a = j * per, b = std::min(rows, a + per);
    for (int t = a; t < b; t++) audio[t] = k_.dot(sl.f() + size_t(t) * sl.ch, w_.clw, K) + w_.clb;
  });
  stage_save(s, sl, rows);
}

}  // namespace pk
