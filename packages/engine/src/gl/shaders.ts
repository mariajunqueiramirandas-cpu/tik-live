/**
 * GLSL ES 3.00 shaders (ADR-0009). Coordinates are logical stage pixels
 * (1080x1920, y down); `rect` places a unit quad on the stage.
 */

export const RECT_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
uniform vec2 u_res;
uniform vec4 u_rect;
out vec2 v_uv;
void main() {
  vec2 p = u_rect.xy + a_corner * u_rect.zw;
  v_uv = a_corner;
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
}`;

const NOISE = /* glsl */ `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}`;

export const ATMOSPHERE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_bg;
uniform vec3 u_primary;
uniform vec3 u_secondary;
uniform vec3 u_gold;
uniform vec2 u_orb;
uniform float u_glow;
uniform float u_flash;
uniform vec4 u_halo;     // body radius (stage px), squash, voice amplitude, character alpha
uniform float u_haloAa;  // about two screen pixels, in body radii
uniform vec2 u_fx;       // spotlight 0..1, gold over the whole stage 0..1
${NOISE}
// Rendered at reduced resolution into an offscreen buffer (everything here is
// soft); UPSCALE_FRAGMENT brings it to full size and adds the dither.
void main() {
  vec2 px = v_uv * u_res;
  float y = v_uv.y;
  vec3 top = mix(u_bg, u_primary, 0.10);
  vec3 bottom = u_bg * 0.62;
  vec3 col = mix(top, u_bg, smoothstep(0.0, 0.45, y));
  col = mix(col, bottom, smoothstep(0.45, 1.0, y));

  // Light shafts from the surface.
  float shafts = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float sway = sin(u_time * 0.15 + fi * 1.7) * 90.0;
    float d = (px.x - (160.0 + fi * 250.0 + sway)) - px.y * 0.32;
    shafts += smoothstep(140.0, 0.0, abs(d - 60.0));
  }
  col += u_primary * shafts * 0.05 * (1.0 - smoothstep(0.0, 0.75, y));

  // Caustics rippling near the top.
  vec2 q = px / 150.0;
  float c = noise(q + vec2(u_time * 0.07, u_time * 0.05)) + noise(q * 1.9 - vec2(u_time * 0.05, -u_time * 0.06));
  float caustic = pow(1.0 - abs(c - 1.0), 8.0);
  col += u_primary * caustic * 0.045 * (1.0 - smoothstep(0.0, 0.45, y));

  // The character's light on the water, plus the gold flash from gifts.
  float dist = length(px - u_orb);
  col += (u_primary * 0.33 + u_secondary * 0.14) * exp(-dist / 270.0) * u_glow;
  col += u_gold * exp(-dist / 230.0) * u_flash * 0.45;

  // The character's halo. It used to be part of the orb pass, which then ran
  // the whole face shader over a quad mostly covered by halo; here it costs a
  // sixteenth of the pixels. The body, drawn on top at full resolution, covers
  // the inside.
  if (u_halo.w > 0.0) {
    vec2 bp = (px - u_orb) / u_halo.x;
    bp /= vec2(1.0 + u_halo.y, 1.0 - u_halo.y);
    float ang = atan(bp.y, bp.x);
    float wob = 1.0 + 0.025 * sin(3.0 * ang + u_time * 1.7) + 0.018 * sin(2.0 * ang - u_time * 1.1) + u_halo.z * 0.022 * sin(5.0 * ang + u_time * 7.0);
    float dBody = length(bp) - wob;
    float halo = exp(-max(dBody, 0.0) * 4.0) * (0.3 + u_halo.z * 0.35 + u_flash * 0.35) * smoothstep(-u_haloAa, u_haloAa, dBody) * u_halo.w;
    vec3 haloCol = mix(u_primary, u_secondary, 0.3) + u_gold * u_flash * 0.4;
    col = col * (1.0 - 0.5 * halo) + haloCol * halo;
  }

  // Spotlight: a cone of light from above onto the character, the rest dimmed.
  if (u_fx.x > 0.0) {
    float r = u_halo.x;
    float spread = 50.0 + max(0.0, px.y + 200.0) / (u_orb.y + 200.0) * r * 1.4;
    float cone = smoothstep(spread, spread * 0.5, abs(px.x - u_orb.x)) * smoothstep(u_orb.y + r * 2.4, u_orb.y + r * 0.8, px.y);
    vec2 pd = (px - u_orb - vec2(0.0, r * 1.35)) / vec2(r * 1.7, r * 0.32);
    col *= 1.0 - u_fx.x * 0.62 * (1.0 - cone);
    col += (vec3(1.0, 0.95, 0.82) * 0.2 * cone + u_primary * 0.3 * exp(-dot(pd, pd))) * u_fx.x;
  }
  col += u_gold * u_fx.y * 0.4;

  vec2 vv = v_uv - 0.5;
  col *= 1.0 - dot(vv, vv) * 0.55;
  o = vec4(col, 1.0);
}`;

/**
 * Scales the reduced-resolution atmosphere to full size and dithers it, so
 * gradients don't band after video encoding. The dither pattern is fixed,
 * not animated: noise that changes every frame forces video encoders to
 * re-encode the whole background each frame, instead of skipping it.
 */
export const UPSCALE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_res;
${NOISE}
void main() {
  // Render targets store rows bottom-up; v_uv runs top-down.
  vec3 col = texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y)).rgb;
  col += (hash(v_uv * u_res) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}`;

export const MOTES_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_instance;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_orb;
uniform float u_amp;
out vec2 v_uv;
out float v_alpha;
void main() {
  float speed = 6.0 + a_instance.w * 18.0;
  float size = 1.5 + 3.5 * fract(a_instance.x * 7.13);
  float span = u_res.y + 40.0;
  float x = a_instance.x * u_res.x + sin(u_time * 0.6 + a_instance.y * 6.2831) * 14.0;
  float y = mod(a_instance.z * span - u_time * speed, span) - 20.0;
  float near = max(0.0, 1.0 - length(vec2(x, y) - u_orb) / 520.0);
  v_alpha = 0.15 + 0.45 * fract(a_instance.y * 3.7) + near * u_amp * 0.6;
  vec2 p = vec2(x, y) + (a_corner - 0.5) * size * 6.0;
  v_uv = a_corner - 0.5;
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
}`;

export const GLOW_DOT_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 v_uv;
in float v_alpha;
out vec4 o;
uniform vec3 u_color;
void main() {
  float d = length(v_uv) * 2.0;
  float a = (smoothstep(0.35, 0.0, d) + smoothstep(1.0, 0.0, d) * 0.35) * v_alpha;
  o = vec4(u_color * a, a);
}`;

export const ORB_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform float u_time;
uniform float u_amp;
uniform vec3 u_primary;
uniform vec3 u_secondary;
uniform vec3 u_ink;
uniform vec3 u_gold;
uniform float u_desat;
uniform float u_flash;
uniform float u_squash;
uniform float u_extent;  // quad half-size, in body radii
uniform float u_px;      // one screen pixel, in body radii
uniform vec4 u_eye;      // openness, width, happy arc, heart
uniform vec4 u_eye2;     // lid cut, brow, sparkle, blink
uniform vec2 u_gaze;
uniform vec4 u_mouth;    // open, smile, round, smirk
uniform vec2 u_vowel;    // while talking: round (o, u), wide (i, e)
uniform float u_blush;
uniform float u_alpha;   // cross-fade with the other character style
uniform float u_rot;     // spin and head tilt, radians

float sdEllipse(vec2 p, vec2 r) { return (length(p / r) - 1.0) * min(r.x, r.y); }
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
// An upper half ring (∩) of radius r, stroke half-width t, with round caps.
float sdArcUp(vec2 p, float r, float t) {
  if (p.y <= 0.0) return abs(length(p) - r) - t;
  return min(length(p - vec2(r, 0.0)), length(p - vec2(-r, 0.0))) - t;
}
float sdArcDown(vec2 p, float r, float t) { return sdArcUp(vec2(p.x, -p.y), r, t); }
float dot2(vec2 v) { return dot(v, v); }
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  return sqrt(min(dot2(p - vec2(0.0, 1.0)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float fill(float d, float aa) { return 1.0 - smoothstep(-aa, aa, d); }

void main() {
  vec2 p = rot(u_rot) * ((v_uv - 0.5) * 2.0 * u_extent);
  p.x /= (1.0 + u_squash);
  p.y /= (1.0 - u_squash);
  float aa = u_px * 1.2;

  float ang = atan(p.y, p.x);
  float wob = 1.0 + 0.025 * sin(3.0 * ang + u_time * 1.7) + 0.018 * sin(2.0 * ang - u_time * 1.1) + u_amp * 0.022 * sin(5.0 * ang + u_time * 7.0);
  float dBody = length(p) - wob;
  float body = fill(dBody, aa);

  // Body: lit from the top left, primary into secondary toward the rim.
  float g = clamp(length(p - vec2(-0.3, -0.35)) / 1.35, 0.0, 1.0);
  vec3 c2 = mix(u_primary, u_secondary, 0.65);
  vec3 col = mix(vec3(1.0), u_primary, smoothstep(0.0, 0.27, g));
  col = mix(col, c2, smoothstep(0.27, 0.8, g));
  col = mix(col, u_secondary, smoothstep(0.8, 1.0, g));
  col += u_primary * smoothstep(-0.25, 0.0, dBody) * 0.22;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum) * 0.9, u_desat);
  col = mix(col, u_gold, u_flash * 0.22);

  // Gloss.
  float gloss = fill(sdEllipse(rot(-0.6) * (p - vec2(-0.38, -0.5)), vec2(0.2, 0.1)), aa * 3.0 + 0.03);
  col = mix(col, vec3(1.0), gloss * 0.35);

  // Face.
  vec2 gaze = u_gaze * 0.08;
  float ink = 0.0;
  float shine = 0.0;
  float open = max(0.03, u_eye.x * (1.0 - u_eye2.w * 0.93));
  for (int i = 0; i < 2; i++) {
    float side = i == 0 ? -1.0 : 1.0;
    vec2 c = vec2(side * 0.32, -0.08) + gaze;
    vec2 q = p - c;
    float dEye = sdEllipse(q, vec2(0.13 * u_eye.y, 0.2 * open));
    float dHappy = sdArcUp(q - vec2(0.0, 0.07), 0.13, 0.034);
    vec2 hp = vec2(q.x, -q.y) / 0.19 + vec2(0.0, 0.55);
    float dHeart = sdHeart(hp) * 0.19;
    float d = mix(dEye, dHappy, u_eye.z);
    d = mix(d, dHeart, u_eye.w);
    // Mischief: a flat upper lid cuts the top of the eye.
    float lid = mix(-0.3, 0.02, u_eye2.x) * open;
    d = max(d, lid - q.y);
    float eye = fill(d, aa);
    ink = max(ink, eye);
    float r = (0.035 + u_eye2.z * 0.025) * clamp(open, 0.0, 1.0) * (1.0 - u_eye.z) * (1.0 - u_eye.w);
    shine = max(shine, fill(length(q - vec2(0.045, -0.08 * open)) - r, aa) * eye);
    shine = max(shine, fill(length(q - vec2(-0.035, 0.06 * open)) - r * 0.45 * u_eye2.z, aa) * eye);
    // Sad brows.
    vec2 b0 = c + vec2(-0.12 * side, -0.35); // inner end, raised
    vec2 b1 = c + vec2(0.13 * side, -0.27);  // outer end, lower
    ink = max(ink, fill(sdSegment(p, b0, b1) - 0.022, aa) * u_eye2.y);
  }

  vec2 m = rot(u_mouth.w * 0.35) * (p - vec2(0.0, 0.3) - gaze * 0.5) + vec2(u_mouth.w * 0.03, 0.0);
  float talk = smoothstep(0.03, 0.14, u_mouth.x);
  float dLine = sdSegment(m, vec2(-0.08, 0.0), vec2(0.08, 0.0)) - 0.025;
  float smile = clamp(u_mouth.y, -1.0, 1.0);
  float dCurve = smile >= 0.0 ? mix(dLine, sdArcDown(m + vec2(0.0, 0.035), 0.09, 0.025), smile)
                              : mix(dLine, sdArcUp(m - vec2(0.0, 0.05), 0.08, 0.025), -smile);
  vec2 openR = vec2(0.1 + u_mouth.x * 0.07, 0.03 + u_mouth.x * 0.17);
  openR *= vec2(1.0 - u_vowel.x * 0.38 + u_vowel.y * 0.28, 1.0 + u_vowel.x * 0.1 - u_vowel.y * 0.35);
  float dOpen = sdEllipse(m - vec2(0.0, 0.02), openR);
  float dRound = length(m - vec2(0.0, 0.02)) - 0.05;
  float dm = mix(dCurve, dOpen, talk);
  dm = mix(dm, dRound, u_mouth.z * (1.0 - talk));
  ink = max(ink, fill(dm, aa));

  float blush = 0.0;
  for (int i = 0; i < 2; i++) {
    float side = i == 0 ? -1.0 : 1.0;
    vec2 bq = (p - vec2(side * 0.5, 0.16) - gaze) / vec2(0.12, 0.06);
    blush += exp(-dot(bq, bq) * 1.6);
  }
  col = mix(col, u_secondary, clamp(blush, 0.0, 1.0) * u_blush * 0.5);
  col = mix(col, u_ink, ink);
  col = mix(col, vec3(1.0), shine * 0.92);

  // The soft outer glow is drawn with the atmosphere (ATMOSPHERE_FRAGMENT).
  o = vec4(col * body, body) * u_alpha;
}`;

export const VOICE_LINE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform vec4 u_rect;
uniform float u_time;
uniform float u_amp;
uniform vec3 u_primary;
uniform vec3 u_secondary;
uniform vec3 u_gold;
uniform float u_flash;
uniform float u_px;
uniform float u_alpha;
uniform vec4 u_mood;  // speed, calm (sleepy, sad), jitter (confused), warmth (love, shy)
float wave(float x, float t, float phase, float a) {
  float edge = sin(clamp((x - 160.0) / 760.0, 0.0, 1.0) * 3.14159);
  float w = sin(x * 0.02 + t * 6.0 * u_mood.x + phase) * 0.6 + sin(x * 0.045 - t * 9.0 * u_mood.x + phase * 1.7) * 0.4;
  w += sin(x * 0.13 + t * 17.0 + phase * 3.1) * u_mood.z * 0.45;
  return w * edge * a * (1.0 - u_mood.y * 0.55);
}
void main() {
  vec2 px = u_rect.xy + v_uv * u_rect.zw;
  float cy = u_rect.y + u_rect.w * 0.5;
  float a = 8.0 + u_amp * 120.0;
  float fade = smoothstep(40.0, 260.0, px.x) * (1.0 - smoothstep(820.0, 1040.0, px.x));
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float d = abs(px.y - (cy + wave(px.x, u_time, fi * 2.1, a * (1.0 - fi * 0.28))));
    float core = 1.0 - smoothstep(2.0 - fi * 0.5, 2.0 + u_px * 2.0, d);
    float halo = exp(-d / (16.0 + u_amp * 14.0)) * 0.45;
    vec3 c = i == 0 ? u_primary : (i == 1 ? u_secondary : mix(u_primary, u_secondary, 0.5));
    c = mix(c, u_secondary, u_mood.w * 0.5);
    c = mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))), u_mood.y * 0.45);
    c = mix(c, u_gold, u_flash * 0.5);
    float s = (core * 0.75 + halo) * (1.0 - fi * 0.3) * fade;
    col += c * s;
    alpha += s * 0.6;
  }
  o = vec4(col, clamp(alpha, 0.0, 1.0)) * u_alpha;
}`;

/** A sprite showing one texture (most frames: no cross-fade running). */
export const SPRITE_SINGLE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform float u_opacity;
void main() {
  o = texture(u_tex, v_uv) * u_opacity;
}`;

export const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform sampler2D u_tex2;
uniform float u_mix;
uniform float u_opacity;
void main() {
  o = mix(texture(u_tex, v_uv), texture(u_tex2, v_uv), u_mix) * u_opacity;
}`;

// ---------------------------------------------------------------------------
// Cloud broadcast capture (ADR-0020): the finished frame, converted on the
// rasterizer to I420 (BT.709, limited range) in the exact byte layout the
// encoder reads, so the CPU never converts or reorders pixels. The target is
// W/4 texels wide (4 samples per RGBA texel) and 1.5 * H rows: the Y plane,
// then U and V, two chroma rows per target row. Rows are numbered from the
// bottom, which is the order readPixels returns them in.

/** Covers the whole viewport; the YUV shaders work from gl_FragCoord. */
export const FULLSCREEN_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
void main() {
  gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Luma: target rows 0..H-1, four pixels per texel. */
export const YUV_LUMA_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D u_frame;  // the stage, W x H, rows bottom-up
uniform ivec2 u_size;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float luma(int x, int row) {
  // Image row "row" counts from the top; the frame texture stores it at H-1-row.
  return dot(texelFetch(u_frame, ivec2(x, u_size.y - 1 - row), 0).rgb, KY);
}
void main() {
  int x = int(gl_FragCoord.x) * 4;
  int row = int(gl_FragCoord.y);
  o = vec4(luma(x, row), luma(x + 1, row), luma(x + 2, row), luma(x + 3, row)) * (219.0 / 255.0) + 16.0 / 255.0;
}`;

/** Chroma: target rows H..1.5H-1 hold U then V, each 2x2 block averaged by one bilinear fetch. */
export const YUV_CHROMA_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D u_frame;
uniform ivec2 u_size;
const vec3 KU = vec3(-0.1146, -0.3854, 0.5);
const vec3 KV = vec3(0.5, -0.4542, -0.0458);
vec3 block(int cx, int crow) {
  vec2 size = vec2(u_size);
  // The shared corner of the 2x2 block: bilinear filtering averages all four.
  return texture(u_frame, vec2(float(2 * cx + 1) / size.x, 1.0 - float(2 * crow + 1) / size.y)).rgb;
}
void main() {
  int k = int(gl_FragCoord.y) - u_size.y;      // 0 .. H/2 - 1
  int quarter = u_size.y / 4;
  vec3 K = k < quarter ? KU : KV;
  k -= k < quarter ? 0 : quarter;
  int perRow = u_size.x / 8;                    // texels per chroma row (W/2 samples)
  int c = int(gl_FragCoord.x);
  int crow = 2 * k + (c >= perRow ? 1 : 0);
  int cx = (c >= perRow ? c - perRow : c) * 4;
  o = vec4(dot(block(cx, crow), K), dot(block(cx + 1, crow), K), dot(block(cx + 2, crow), K), dot(block(cx + 3, crow), K)) * (224.0 / 255.0) + 128.0 / 255.0;
}`;
