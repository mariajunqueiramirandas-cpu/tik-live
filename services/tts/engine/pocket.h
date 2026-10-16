/* Pocket TTS inference engine, C API (loaded by tts/engine.py through ctypes). */
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pk_engine pk_engine;

typedef struct {
  int lm_threads;    /* cores for the speech model's matmuls (>= 1) */
  int mimi_threads;  /* cores for the audio decoder (>= 1); runs concurrently with the model */
  int max_batch;     /* sequences decoded per step; 0 = manual mode (pk_debug_* only, no threads) */
  int max_tokens;    /* tokens per sequence */
  int chunk;         /* latents per decoder call (80 ms each) */
  const char* isa;   /* "amx", "avx512", "avxvnni", "avx2" or NULL for the best the CPU has */
  int speech_bits;   /* the speech model's transformer weights: 8, or 4 (a file packed with int4) */
} pk_options;

pk_engine* pk_open(const char* model_path, const pk_options* opt, char* err, int errlen);
void pk_close(pk_engine* e);

const char* pk_isa(const pk_engine* e);
int pk_speech_bits(const pk_engine* e);
/* How the audio decoder's transformer runs: "f32", "q12", "q8" (timed at startup) or "bf16" (AMX). */
const char* pk_decoder_mode(const pk_engine* e);
int pk_sample_rate(const pk_engine* e);
int pk_voice_count(const pk_engine* e);
const char* pk_voice_name(const pk_engine* e, int i);
int pk_max_tokens(const pk_engine* e);

/* Queues one sequence (a text chunk's tokens). temp: noise variance (0.3 is the model's);
   frames_after_eos: frames kept after the end-of-speech signal. Returns an id > 0, or -1 on bad
   input. */
int64_t pk_submit(pk_engine* e, const int32_t* tokens, int n, int voice, float temp, int frames_after_eos,
                  uint64_t seed);
/* Copies up to cap new 16-bit samples. Returns the count (> 0), 0 when nothing new arrived within
   timeout_ms, -1 once the sequence is finished and fully read, -2 for an unknown id or a failed
   sequence. */
int pk_read(pk_engine* e, int64_t id, int16_t* out, int cap, int timeout_ms);
/* Forgets a sequence, stopping it if it is still running. */
void pk_release(pk_engine* e, int64_t id);
/* queued (waiting for the model), active (in the model), decoding (latents not yet audio) */
void pk_stats(pk_engine* e, int* queued, int* active, int* decoding);

/* Manual mode, for tests and benchmarks. noise: [max_steps][ldim], already scaled. Returns the
   number of latents written to latents [.][ldim]; eos gets every computed step's logit and hidden
   (if not NULL) every step's transformer output [max_steps][d_model]. With teacher [max_steps][ldim]
   (else NULL), step i+1 reads teacher[i] instead of its own latent and every step runs, so each
   step's error can be measured against another run without drift. */
int pk_debug_generate(pk_engine* e, int voice, const int32_t* tokens, int n, const float* noise, int max_steps,
                      int frames_after_eos, float* latents, float* eos, float* hidden, const float* teacher);
/* Decodes latents [n][ldim] with a fresh decoder state, `chunk` latents per call. */
int pk_debug_decode(pk_engine* e, const float* latents, int n, int chunk, float* audio);
/* With PK_PROFILE=1 in the environment: prints the time per engine section to stderr, then resets. */
void pk_profile_dump(void);

#ifdef __cplusplus
}
#endif
