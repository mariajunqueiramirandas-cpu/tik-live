// The packed model file (written by tts/pack.py) and typed views of its weights.
#pragma once

#include <string>
#include <unordered_map>
#include <vector>

#include "internal.h"

namespace pk {

enum DType : uint32_t { kF32 = 0, kF16 = 1, kI8 = 2, kI32 = 3, kU4 = 4 };  // kU4: two codes per byte

struct Tensor {
  uint32_t dtype = 0, ndim = 0;
  int64_t dims[4] = {0, 0, 0, 0};
  const void* data = nullptr;
  size_t nbytes = 0;
};

class ModelFile {
 public:
  explicit ModelFile(const std::string& path);
  ~ModelFile();
  ModelFile(const ModelFile&) = delete;
  ModelFile& operator=(const ModelFile&) = delete;

  Config cfg{};
  bool has(const std::string& name) const { return tensors_.count(name) != 0; }
  const Tensor& get(const std::string& name) const;
  const float* f32(const std::string& name, size_t count) const;
  QW q8(const std::string& name, int N, int K, bool bias) const;
  QW4 q4(const std::string& name, int N, int K, bool bias) const;
  PW panels(const std::string& name, int N, int K, bool bias) const;
  // int4: the file's int4 copy (QW4) where it has one, required
  Linear linear(const std::string& name, int N, int K, bool bias, bool int4 = false) const;
  std::vector<std::string> voices() const;

 private:
  void* map_ = nullptr;
  size_t size_ = 0;
  std::unordered_map<std::string, Tensor> tensors_;
};

struct LMLayer {
  const float *n1w, *n1b, *n2w, *n2b;
  Linear qkv, o, ff1, ff2;
};

struct FlowBlock {
  const float *lnw, *lnb;
  Linear m0, m2;
};

struct Voice {
  std::string name;
  int len;  // positions of the prompt
  const uint16_t* kv;  // [L][2][len][H][Dh] float16
};

struct LMWeights {
  const float* lut;  // [vocab][D]
  const float* bos;  // [ldim]
  PW in;             // ldim -> D
  std::vector<LMLayer> layers;
  const float *onw, *onb, *eosw;
  float eosb;
  Linear cond, ada;  // D -> flow_dim (time constant in the bias); flow_dim -> (3 depth + 2) flow_dim
  PW fin, fout;      // ldim -> flow_dim; flow_dim -> ldim
  std::vector<FlowBlock> blocks;
  std::vector<Voice> voices;
};

struct ConvW {  // causal conv as GEMM: W [cout][k*cin]
  Linear w;
  int k, cin, cout;
};

struct ConvTrW {  // transposed conv with kernel 2s as a 2-tap GEMM: B [2*cin][s*cout]
  PW w;
  int s, cin, cout;
};

struct MimiLayer {
  const float *n1w, *n1b, *n2w, *n2b;
  Linear qkv, o, ff1, ff2;
};

struct MimiWeights {
  PW in;            // ldim -> m_dim, latent denormalization folded in
  const float* up;  // depthwise transposed conv taps [2*upsample][m_dim]
  std::vector<MimiLayer> layers;
  ConvW c0;
  std::vector<ConvTrW> ups;
  std::vector<std::vector<ConvW>> res;  // per stage: a0, b0, a1, b1, ...
  const float* clw;                     // [last_kernel * n_filters]
  float clb;
};

LMWeights load_lm(const ModelFile& f, bool int4);
MimiWeights load_mimi(const ModelFile& f);

}  // namespace pk
