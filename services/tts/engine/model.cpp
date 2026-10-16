#include "model.h"

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>

namespace pk {

namespace {

constexpr char kMagic[8] = {'P', 'K', 'T', 'T', 'S', 0, 0, 0};
constexpr uint32_t kVersion = 2;
constexpr int kNameLen = 56;
constexpr int kConfigInts = 20;

#pragma pack(push, 1)
struct Entry {
  char name[kNameLen];
  uint32_t dtype, ndim;
  int64_t dims[4];
  uint64_t offset, nbytes;
};
#pragma pack(pop)

[[noreturn]] void fail(const std::string& msg) { throw std::runtime_error(msg); }

size_t tensor_bytes(uint32_t dt, size_t count) { return dt == kU4 ? count / 2 : count * (dt == kF32 || dt == kI32 ? 4 : dt == kF16 ? 2 : 1); }

}  // namespace

void* aligned_alloc64(size_t bytes) {
  void* p = nullptr;
  if (posix_memalign(&p, 64, bytes ? (bytes + 63) & ~size_t(63) : 64)) throw std::bad_alloc();
  return p;
}

void aligned_free(void* p) { free(p); }

ModelFile::ModelFile(const std::string& path) {
  int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) fail("cannot open " + path);
  struct stat st;
  if (fstat(fd, &st) != 0) {
    close(fd);
    fail("cannot stat " + path);
  }
  size_ = size_t(st.st_size);
  map_ = mmap(nullptr, size_, PROT_READ, MAP_PRIVATE, fd, 0);
  close(fd);
  if (map_ == MAP_FAILED) {
    map_ = nullptr;
    fail("cannot map " + path);
  }
  const char* base = static_cast<const char*>(map_);
  size_t at = 0;
  auto take = [&](void* dst, size_t n) {
    if (at + n > size_) fail(path + ": truncated header");
    std::memcpy(dst, base + at, n);
    at += n;
  };
  char magic[8];
  take(magic, 8);
  if (std::memcmp(magic, kMagic, 8) != 0) fail(path + ": not a packed Pocket TTS model");
  uint32_t version;
  take(&version, 4);
  if (version != kVersion) fail(path + ": format version " + std::to_string(version) + ", engine reads " + std::to_string(kVersion));
  int32_t ints[kConfigInts];
  take(ints, sizeof ints);
  Config& c = cfg;
  int* fields[kConfigInts] = {&c.d_model, &c.heads, &c.layers, &c.ff, &c.ldim, &c.vocab, &c.flow_dim,
                              &c.flow_depth, &c.m_dim, &c.m_heads, &c.m_layers, &c.m_ff, &c.m_context,
                              &c.n_filters, &c.n_residual, &c.kernel, &c.res_kernel, &c.last_kernel,
                              &c.upsample, &c.sample_rate};
  for (int i = 0; i < kConfigInts; i++) *fields[i] = ints[i];
  int32_t ratios[kMaxRatios + 1];
  take(ratios, sizeof ratios);
  c.n_ratios = ratios[0];
  if (c.n_ratios < 1 || c.n_ratios > kMaxRatios) fail(path + ": bad ratios");
  for (int i = 0; i < kMaxRatios; i++) c.ratios[i] = ratios[i + 1];
  float periods[2];
  take(periods, sizeof periods);
  c.max_period = periods[0];
  c.m_max_period = periods[1];
  uint32_t n;
  take(&n, 4);
  for (uint32_t i = 0; i < n; i++) {
    Entry e;
    take(&e, sizeof e);
    e.name[kNameLen - 1] = 0;
    if (e.offset % 64 || e.offset + e.nbytes > size_) fail(path + ": bad tensor bounds for " + e.name);
    size_t count = 1;
    for (uint32_t d = 0; d < e.ndim && d < 4; d++) count *= size_t(e.dims[d]);
    Tensor t;
    t.dtype = e.dtype;
    t.ndim = e.ndim;
    std::memcpy(t.dims, e.dims, sizeof t.dims);
    t.data = base + e.offset;
    t.nbytes = e.nbytes;
    // packed int8 and int4 matrices declare their logical [N, K] shape
    if (e.dtype > kU4 || tensor_bytes(e.dtype, count) != e.nbytes) fail(path + ": size mismatch for " + e.name);
    tensors_.emplace(e.name, t);
  }
  const bool dims_ok = c.d_model % c.heads == 0 && c.head_dim() % 16 == 0 && c.head_dim() <= 64 &&
                       c.m_dim % c.m_heads == 0 && c.m_head_dim() % 16 == 0 && c.m_head_dim() <= 64 &&
                       c.d_model % 32 == 0 && c.m_dim % 32 == 0 && c.flow_dim % 32 == 0 && c.ldim % 32 == 0;
  if (!dims_ok) fail(path + ": unsupported dimensions");
}

ModelFile::~ModelFile() {
  if (map_) munmap(map_, size_);
}

const Tensor& ModelFile::get(const std::string& name) const {
  auto it = tensors_.find(name);
  if (it == tensors_.end()) fail("model file lacks " + name);
  return it->second;
}

const float* ModelFile::f32(const std::string& name, size_t count) const {
  const Tensor& t = get(name);
  if (t.dtype != kF32 || t.nbytes != count * 4) fail("bad shape for " + name);
  return static_cast<const float*>(t.data);
}

QW ModelFile::q8(const std::string& name, int N, int K, bool bias) const {
  const Tensor& t = get(name + ".q");
  if (t.dtype != kI8 || t.dims[0] != N || t.dims[1] != K || N % 16 || K % 4) fail("bad shape for " + name);
  QW w;
  w.N = N, w.K = K;
  w.q = static_cast<const int8_t*>(t.data);
  w.s = f32(name + ".s", N);
  const Tensor& z = get(name + ".z");
  if (z.dtype != kI32 || z.nbytes != size_t(N) * 4) fail("bad shape for " + name + ".z");
  w.z = static_cast<const int32_t*>(z.data);
  w.b = bias ? f32(name + ".b", N) : nullptr;
  if (has(name + ".r")) {
    if (K > kMaxRotK || K < 16 || (K & (K - 1))) fail("cannot rotate " + name);
    w.r = f32(name + ".r", K);
  }
  return w;
}

QW4 ModelFile::q4(const std::string& name, int N, int K, bool bias) const {
  const Tensor& t = get(name + ".u");
  if (t.dtype != kU4 || t.dims[0] != N || t.dims[1] != K || N % 16 || K % 32 || K > kMaxRotK || (K & (K - 1)))
    fail("bad shape for " + name);
  QW4 w;
  w.N = N, w.K = K;
  w.q = static_cast<const uint8_t*>(t.data);
  w.s = f32(name + ".s4", N);
  w.b = bias ? f32(name + ".b", N) : nullptr;
  w.r = f32(name + ".r", K);
  return w;
}

PW ModelFile::panels(const std::string& name, int N, int K, bool bias) const {
  const Tensor& t = get(name + ".p");
  if (t.dtype != kF32 || t.dims[0] != N || t.dims[1] != K || N % 32) fail("bad shape for " + name);
  PW w;
  w.N = N, w.K = K;
  w.p = static_cast<const float*>(t.data);
  w.b = bias ? f32(name + ".b", N) : nullptr;
  return w;
}

Linear ModelFile::linear(const std::string& name, int N, int K, bool bias, bool int4) const {
  Linear l;
  if (int4) {
    if (!has(name + ".u")) fail("model file has no int4 copy of " + name + " (pack it with --int4)");
    l.q4 = true;
    l.w4 = q4(name, N, K, bias);
    return l;
  }
  l.q8 = has(name + ".q");
  if (l.q8) l.q = q8(name, N, K, bias);
  if (!l.q8 || has(name + ".p")) l.f = panels(name, N, K, bias);
  return l;
}

std::vector<std::string> ModelFile::voices() const {
  std::vector<std::string> out;
  for (const auto& kv : tensors_)
    if (kv.first.rfind("voice.", 0) == 0) out.push_back(kv.first.substr(6));
  return out;
}

LMWeights load_lm(const ModelFile& f, bool int4) {
  const Config& c = f.cfg;
  LMWeights w;
  const int D = c.d_model, F = c.flow_dim;
  w.lut = f.f32("lut", size_t(c.vocab) * D);
  w.bos = f.f32("bos", c.ldim);
  w.in = f.panels("in", D, c.ldim, false);
  for (int i = 0; i < c.layers; i++) {
    const std::string p = "l" + std::to_string(i) + ".";
    LMLayer l;
    l.n1w = f.f32(p + "n1.w", D), l.n1b = f.f32(p + "n1.b", D);
    l.n2w = f.f32(p + "n2.w", D), l.n2b = f.f32(p + "n2.b", D);
    l.qkv = f.linear(p + "qkv", 3 * D, D, false, int4);
    l.o = f.linear(p + "o", D, D, false, int4);
    l.ff1 = f.linear(p + "ff1", c.ff, D, false, int4);
    l.ff2 = f.linear(p + "ff2", D, c.ff, false, int4);
    w.layers.push_back(l);
  }
  w.onw = f.f32("on.w", D), w.onb = f.f32("on.b", D);
  w.eosw = f.f32("eos.w", D);
  w.eosb = *f.f32("eos.b", 1);
  w.cond = f.linear("f.cond", F, D, true);
  w.ada = f.linear("f.ada", (3 * c.flow_depth + 2) * F, F, true);
  w.fin = f.panels("f.in", F, c.ldim, true);
  w.fout = f.panels("f.out", c.ldim, F, true);
  for (int i = 0; i < c.flow_depth; i++) {
    const std::string p = "f" + std::to_string(i) + ".";
    FlowBlock b;
    b.lnw = f.f32(p + "ln.w", F), b.lnb = f.f32(p + "ln.b", F);
    b.m0 = f.linear(p + "m0", F, F, true);
    b.m2 = f.linear(p + "m2", F, F, true);
    w.blocks.push_back(b);
  }
  for (const std::string& name : f.voices()) {
    const Tensor& t = f.get("voice." + name);  // [L, 2, T, H*Dh]
    if (t.dtype != kF16 || t.ndim != 4 || t.dims[0] != c.layers || t.dims[1] != 2 || t.dims[3] != D)
      throw std::runtime_error("bad voice " + name);
    w.voices.push_back({name, int(t.dims[2]), static_cast<const uint16_t*>(t.data)});
  }
  return w;
}

MimiWeights load_mimi(const ModelFile& f) {
  const Config& c = f.cfg;
  MimiWeights w;
  const int M = c.m_dim;
  w.in = f.panels("m.in", M, c.ldim, true);
  w.up = f.f32("m.up", size_t(2 * c.upsample) * M);
  for (int i = 0; i < c.m_layers; i++) {
    const std::string p = "ml" + std::to_string(i) + ".";
    MimiLayer l;
    l.n1w = f.f32(p + "n1.w", M), l.n1b = f.f32(p + "n1.b", M);
    l.n2w = f.f32(p + "n2.w", M), l.n2b = f.f32(p + "n2.b", M);
    l.qkv = f.linear(p + "qkv", 3 * M, M, false);
    l.o = f.linear(p + "o", M, M, false);
    l.ff1 = f.linear(p + "ff1", c.m_ff, M, false);
    l.ff2 = f.linear(p + "ff2", M, c.m_ff, false);
    w.layers.push_back(l);
  }
  int ch = c.n_filters << c.n_ratios;  // channels after the first conv
  w.c0 = {f.linear("c0", ch, c.kernel * M, true), c.kernel, M, ch};
  for (int j = 0; j < c.n_ratios; j++) {
    const int s = c.ratios[j], out = ch / 2;
    w.ups.push_back({f.panels("u" + std::to_string(j), s * out, 2 * ch, true), s, ch, out});
    ch = out;
    std::vector<ConvW> rs;
    for (int r = 0; r < c.n_residual; r++) {
      const std::string p = "r" + std::to_string(j) + "." + std::to_string(r) + ".";
      const int hid = ch / 2;
      rs.push_back({f.linear(p + "a", hid, c.res_kernel * ch, true), c.res_kernel, ch, hid});
      rs.push_back({f.linear(p + "b", ch, hid, true), 1, hid, ch});
    }
    w.res.push_back(rs);
  }
  w.clw = f.f32("cl.w", size_t(c.last_kernel) * ch);
  w.clb = *f.f32("cl.b", 1);
  return w;
}

}  // namespace pk
