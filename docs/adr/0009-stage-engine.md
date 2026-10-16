# ADR-0009: WebGL2 stage engine

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

The stage is the product as viewers see it: the character, captions, gift
reactions and atmosphere, rendered in a 1080x1920 browser source. v0.1 drew it
with Canvas2D every frame plus DOM text. That works, but:

- Canvas2D gradients and glows are CPU-rasterized. In OBS that competes with
  the encoder; in headless Chromium (cloud broadcast, software GL via
  SwiftShader per the spike) it is the bottleneck.
- DOM text isn't captured by `canvas.captureStream()`, which cloud broadcast
  needs ([ADR-0014](0014-cloud-broadcast.md)).
- Animation was frame-rate dependent in places, and there was no handling for
  GPU context loss, slow machines, or audio prefetch. These are the things
  that make a stream look buggy.

The owner asked for "a proper engine: fast, native-feeling, not buggy". The
same renderer must run in four places: OBS (program), the dashboard studio
and character editor (preview), the landing page hero (demo) and the cloud
broadcaster (broadcast).

## Decision

Build **`@tik-live/engine`**: a dependency-free WebGL2 renderer with a small,
explicit architecture.

### Public API

```ts
const engine = createEngine(canvas, {
  mode: "program" | "preview" | "broadcast" | "demo",
  quality: "auto" | "high" | "balanced" | "low",
  seed?: number,           // deterministic visuals for tests and the landing page
});
engine.apply(message);     // protocol messages from ADR-0008 (speak, alert, segment, stats, stop, hello)
engine.setLook(look);      // persona colors, character type; animates the change
engine.audio;              // AudioEngine: unlock(), volume, captureStream() for broadcast
engine.on("telemetry", fn);// fps, frame-time p95, quality level, errors
engine.renderAt(t);        // fixed-clock rendering for screenshot tests
engine.destroy();
```

### Frame structure (one draw pass per layer, no per-frame allocation)

| Layer | Technique | CPU cost per frame |
|---|---|---|
| Atmosphere | One full-screen triangle; fragment shader does the depth gradient, animated caustics (value noise), light shafts and vignette from palette uniforms | uniforms only |
| Motes | Instanced quads; static per-instance attributes (seed, size, speed, phase) uploaded once; position computed in the vertex shader from time; additive blend | uniforms only |
| Offerings (gift particles) | Ring buffer of burst instances (origin, start time, size); bezier path computed in the vertex shader | a sub-buffer write only when a gift arrives |
| Character | One quad; signed-distance-field shader for the body (wobbling blob), rim light, specular, soft glow from the SDF distance, and eyes, mouth and blush as SDF shapes blended by emotion weights | ~20 uniforms |
| UI sprites | Captions, alerts, segment title and the AI disclosure badge, drawn as textured quads with transform and opacity uniforms | only when text changes: Canvas2D rasterization into a texture |

Text is rasterized with Canvas2D (self-hosted fonts, loaded before first use)
into textures **only when content changes**. The caption's word-by-word
highlight re-rasterizes at most once per spoken word (about 3–5 times a
second), with a 120 ms crossfade between the old and new texture so the
highlight glides rather than ticks. Everything moving on screen is a GPU
transform of a cached texture.

### Animation model

- **Time-based everything.** A single clock; `dt` clamped to 50 ms; springs
  integrated in fixed 1/120 s substeps, so motion looks identical at 30, 60 or
  144 fps.
- **Springs, not tweens,** for anything that can be interrupted: emotion
  blend weights (expressions morph smoothly into each other), gaze, squash and
  stretch, glow, alert positions. Interrupting a spring mid-motion never
  produces a jump.
- **Mouth** driven by the audio analyser: RMS envelope (fast attack, slower
  release) for openness, plus energy in three frequency bands mapped to rough
  shapes (open, round, wide). With captions only, a syllable envelope is
  derived from the text (vowel groups), not random noise.
- **Idle life:** blinking on a randomized schedule, small gaze shifts, a
  breathing bob, and attention toward incoming gifts. All seeded, so they're
  reproducible in tests.

### Audio engine

One `AudioContext`. While the current cue plays, the next cue's MP3 is fetched
and decoded. Playback is scheduled on the audio clock (`start(ctx.currentTime
+ 0.02)`) for gapless sentence transitions. In `program` mode the stage sends
`spoken` when the source ends. The analyser feeds the mouth. In `broadcast`
mode output also goes to a `MediaStreamAudioDestinationNode` for capture.
Autoplay locks in normal browsers get an unlock prompt in preview; OBS and the
broadcaster allow autoplay.

### Robustness

| Failure | Handling |
|---|---|
| Slow machine | A quality governor watches frame time (EMA and p95). It steps render scale (1.0 → 0.85 → 0.7) and mote count (100% → 60% → 30%) down after 2 s over budget, and back up after 10 s of headroom. The level is reported in telemetry. |
| GPU context lost (driver reset, OBS scene switch) | `webglcontextlost`: pause the loop. `webglcontextrestored`: rebuild programs, buffers and textures from owned descriptors and re-rasterize text. The stream shows at most a brief freeze. |
| Shader compile failure | Fall back to the atmosphere-only program and caption sprites; report the error in telemetry so the studio shows it. |
| No WebGL2 | Draw a plain message ("Enable hardware acceleration in OBS: Settings > Advanced > Sources") and report it. No second renderer in v1. |
| Disconnect from server | Keep idle animation running; fade out captions; never show error UI on the stream. |
| Hidden preview tab or offscreen | Preview mode pauses rendering via `visibilitychange` and `IntersectionObserver`. Program and broadcast always render. |
| Deploy with protocol change | `hello` with `reload: true` triggers a seamless reload ([ADR-0008](0008-realtime-protocol.md)). |

### Budgets (enforced in CI where measurable)

- Engine plus stage page: **under 60 KB gzipped**.
- **No allocations in the frame loop** (typed arrays preallocated; verified with a heap-snapshot test in the E2E suite).
- Frame time on a mid-range GPU: under 4 ms at 1080x1920. In SwiftShader at 720x1280: under 25 ms (to be measured in Phase 2).

### Extensibility

`Character` is an interface (`update(dt, state)`, `draw(renderer)`,
`rebuild()`). v1 ships `orb` (SDF) and `voice-line` (no character, a glowing
waveform). Image-sprite characters with mouth frames, Live2D or VRM can be
added later without touching the rest of the engine.

## Options Considered

### Option A: Custom WebGL2 engine (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: about 2,000 lines, specialized scene |
| Cost | Engineering time; zero runtime dependencies |
| Scalability | GPU does nearly all the work; tiny CPU footprint per frame |
| Team familiarity | Medium: WebGL2 and GLSL |

**Pros:** smallest bundle; the SDF character needs custom shaders in any
engine anyway; full control of frame pacing, context loss and capture;
resolution-independent, crisp character art.
**Cons:** we own the GL plumbing (state, resources, context restore). Kept
small and covered by deterministic screenshot tests.

### Option B: PixiJS 8

| Dimension | Assessment |
|---|---|
| Complexity | Low to medium |
| Cost | About 200–450 KB of library |
| Scalability | Excellent 2D batching |
| Team familiarity | High in the web-graphics community |

**Pros:** mature renderer, text and filters out of the box; handles context loss.
**Cons:** much larger bundle than our scene needs; the character still needs a
custom shader; less control over frame pacing in the capture path.

### Option C: Three.js

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | About 150 KB or more |
| Scalability | Excellent |
| Team familiarity | High |

**Pros:** great for a future 3D or VRM character.
**Cons:** a 3D scene graph for a 2D composition; heavier than needed for v1.
Reconsider if we ship VRM avatars.

### Option D: Keep Canvas2D (v0.1)

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | None |
| Scalability | CPU-bound; slow under SwiftShader |
| Team familiarity | High |

**Pros:** already works.
**Cons:** CPU-heavy glows; DOM text isn't capturable; no headroom for richer visuals.

## Trade-off Analysis

The scene is small and specialized: one atmosphere, one character, particles
and a handful of text sprites. A general engine would mostly add weight.
Writing about 2,000 lines of focused WebGL2 gives the smallest, fastest,
most controllable result, and the character (the hero of the product) needs
hand-written shaders regardless. The risk is GL plumbing bugs, which we
contain with a tiny resource layer, context-loss handling, and deterministic
screenshot tests.

## Consequences

- Easier: one renderer everywhere (OBS, dashboard, landing page, broadcast); capture works; low CPU in OBS.
- Harder: shader code needs care and visual review; tests need a real browser (Playwright with SwiftShader in CI).
- Revisit: adopt Three.js if we add 3D or VRM characters.

## Action Items

1. [ ] Build the resource layer (programs, buffers, textures, owned descriptors for rebuild).
2. [ ] Implement the clock, spring utilities, seeded RNG and quality governor (pure TS, unit-tested).
3. [ ] Implement the layers: atmosphere, motes, offerings, character (orb, voice-line) and UI sprites (text rasterizer and layout).
4. [ ] Implement the audio engine (prefetch, gapless scheduling, analyser, capture stream).
5. [ ] Implement the protocol client (connection, backoff, resync, telemetry) and the stage page entry.
6. [ ] Add deterministic screenshot tests for each emotion and alert, a context-loss test (`WEBGL_lose_context`), and a bundle-size check.
