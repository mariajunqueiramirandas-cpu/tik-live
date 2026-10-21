/**
 * Effect particles (ADR-0009): one instanced draw for a fixed pool. Motion is
 * analytic in the vertex shader (launch, drag, gravity, sway), so the CPU
 * only writes a particle once, when it's born.
 */
export const PARTICLE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_instance;  // x, y, vx, vy at birth
layout(location = 2) in vec4 a_instance2; // birth time, life, size, kind
layout(location = 3) in vec4 a_instance3; // rgb, seed
uniform vec2 u_res;
uniform float u_time;
uniform float u_behind;  // 1: draw rain and bubbles (behind the character); 0: the rest
out vec2 v_uv;
out vec3 v_color;
out float v_alpha;
out float v_shade;
flat out int v_kind;
//                             dot  confetti heart star sparkle note bubble streak petal hitmarker
const float GRAVITY[10] = float[10](180.0, 640.0, -40.0, 140.0, 0.0, -30.0, -50.0, 0.0, 170.0, 0.0);
const float DRAG[10] = float[10](2.6, 2.3, 1.3, 2.2, 3.0, 1.0, 0.7, 0.05, 1.9, 1.0);
const float SWAY[10] = float[10](0.0, 46.0, 22.0, 0.0, 0.0, 30.0, 24.0, 0.0, 52.0, 0.0);
const float SPIN[10] = float[10](0.0, 9.0, 0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 4.0, 0.0);
void main() {
  int kind = int(a_instance2.w + 0.5);
  float age = u_time - a_instance2.x;
  float p = age / a_instance2.y;
  bool behind = kind == 6 || kind == 7;
  if (p <= 0.0 || p >= 1.0 || behind != (u_behind > 0.5)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_uv = vec2(0.0); v_color = vec3(0.0); v_alpha = 0.0; v_shade = 0.0; v_kind = 0;
    return;
  }
  float seed = a_instance3.w;
  float k = DRAG[kind];
  float e = (1.0 - exp(-k * age)) / k;
  vec2 pos = a_instance.xy + a_instance.zw * e + vec2(0.0, GRAVITY[kind]) * (age - e) / k;
  pos.x += sin(age * 2.7 + seed * 6.283) * SWAY[kind] * min(1.0, age * 2.0);
  float size = a_instance2.z * smoothstep(0.0, 0.1, p);
  if (kind == 4) size *= sin(3.14159 * p) * (0.8 + 0.4 * sin(age * 18.0 + seed * 9.0));
  // A hitmarker lands big and settles.
  if (kind == 9) size *= 1.35 - 0.35 * p;
  float angle = seed * 6.283 + age * SPIN[kind] * (seed - 0.5) * 2.0;
  if (kind == 2 || kind == 5) angle = sin(age * 3.0 + seed * 6.0) * 0.3;
  if (kind == 9) angle = 0.0;
  vec2 c = (a_corner - 0.5);
  vec2 scaleXY = vec2(size);
  v_shade = 1.0;
  if (kind == 1 || kind == 8) {
    // Paper flutter: a fake 3D flip.
    float flip = cos(age * 9.0 + seed * 20.0);
    scaleXY.x *= max(0.15, abs(flip));
    v_shade = 0.65 + 0.35 * abs(flip);
  }
  if (kind == 7) {
    vec2 vel = a_instance.zw;
    angle = atan(vel.x, -vel.y);
    scaleXY = vec2(size * 0.12, size);
  }
  float cs = cos(angle), sn = sin(angle);
  vec2 q = c * scaleXY;
  q = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
  vec2 world = pos + q;
  v_uv = c;
  v_color = a_instance3.rgb;
  v_alpha = smoothstep(0.0, 0.06, p) * (1.0 - smoothstep(0.72, 1.0, p));
  v_kind = kind;
  gl_Position = vec4(world.x / u_res.x * 2.0 - 1.0, 1.0 - world.y / u_res.y * 2.0, 0.0, 1.0);
}`;

export const PARTICLE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec3 v_color;
in float v_alpha;
in float v_shade;
flat in int v_kind;
out vec4 o;
float dot2(vec2 v) { return dot(v, v); }
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  return sqrt(min(dot2(p - vec2(0.0, 1.0)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}
float sdStar5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
float fill(float d) {
  float aa = max(fwidth(d), 0.001);
  return 1.0 - smoothstep(-aa, aa, d);
}
void main() {
  vec2 p = v_uv * 2.0;
  float a = 0.0;
  float glow = 0.0;
  vec3 col = v_color;
  int k = v_kind;
  if (k == 0) {
    float r = length(p);
    a = smoothstep(0.45, 0.0, r);
    glow = smoothstep(1.0, 0.0, r) * 0.5;
    col = mix(v_color, vec3(1.0), a * 0.6);
  } else if (k == 1) {
    vec2 d = abs(p) - vec2(0.55, 0.32);
    a = fill(max(d.x, d.y));
  } else if (k == 2) {
    a = fill(sdHeart(vec2(p.x, -p.y) * 1.15 + vec2(0.0, 0.6)) / 1.15);
    col *= 1.0 + 0.35 * smoothstep(0.5, -0.6, p.y + p.x * 0.3);
  } else if (k == 3) {
    float d = sdStar5(vec2(p.x, -p.y), 0.8, 0.45);
    a = fill(d);
    glow = exp(-max(d, 0.0) * 5.0) * 0.35;
  } else if (k == 4) {
    vec2 q = abs(p);
    float ray = exp(-q.x * 9.0) * (1.0 - q.y) + exp(-q.y * 9.0) * (1.0 - q.x);
    glow = clamp(ray, 0.0, 1.0) + exp(-dot(p, p) * 9.0);
    col = mix(v_color, vec3(1.0), 0.5);
  } else if (k == 5) {
    float head = length((p - vec2(-0.25, 0.48)) / vec2(0.36, 0.27)) - 1.0;
    float stem = sdSegment(p, vec2(0.08, 0.45), vec2(0.08, -0.7)) - 0.08;
    float flag = sdSegment(p, vec2(0.08, -0.7), vec2(0.5, -0.32)) - 0.1;
    a = fill(min(head * 0.27, min(stem, flag)));
  } else if (k == 6) {
    float r = length(p);
    a = fill(abs(r - 0.82) - 0.07) + 0.14 * fill(r - 0.82);
    a += fill(length(p - vec2(-0.32, -0.34)) - 0.14) * 0.7;
    col = mix(v_color, vec3(1.0), 0.4);
  } else if (k == 7) {
    glow = exp(-abs(p.x) * 4.0) * (1.0 - abs(p.y)) * 0.55;
  } else if (k == 9) {
    // A hitmarker: four white ticks on the diagonals around an empty middle, outlined dark.
    vec2 q = abs(p);
    float d = sdSegment(q, vec2(0.26), vec2(0.78));
    float outer = fill(d - 0.15);
    float inner = fill(d - 0.075);
    a = outer;
    col = vec3(inner / max(outer, 0.001));
  } else {
    a = fill(length(p / vec2(0.6, 0.95)) - 1.0);
    col *= 0.9 + 0.2 * (1.0 - abs(p.x));
  }
  // Solid shapes blend normally; glows add light (premultiplied, low alpha).
  float s = a * v_alpha;
  float lit = glow * v_alpha;
  o = vec4(col * v_shade * s + col * lit, s + lit * 0.15);
}`;

export const OFFERINGS_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_instance;  // origin.xy, start time, bend
layout(location = 2) in vec4 a_instance2; // size, duration, big, unused
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_orb;
out vec2 v_uv;
out float v_alpha;
void main() {
  float p = (u_time - a_instance.z) / a_instance2.y;
  if (p <= 0.0 || p >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_uv = vec2(0.0);
    v_alpha = 0.0;
    return;
  }
  float e = p * p * (3.0 - 2.0 * p);
  vec2 a = a_instance.xy;
  vec2 dir = normalize(u_orb - a + vec2(0.0001));
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 pos = mix(a, u_orb, e) + perp * sin(e * 3.14159) * a_instance.w;
  float size = a_instance2.x * (1.0 - e * 0.6) * (a_instance2.z > 0.5 ? 1.5 : 1.0);
  v_alpha = smoothstep(0.0, 0.08, p) * (1.0 - smoothstep(0.92, 1.0, p));
  vec2 corner = (a_corner - 0.5) * size * 8.0;
  v_uv = a_corner - 0.5;
  vec2 q = pos + corner;
  gl_Position = vec4(q.x / u_res.x * 2.0 - 1.0, 1.0 - q.y / u_res.y * 2.0, 0.0, 1.0);
}`;


/**
 * Hype mode (ADR-0046): an RGB LED strip around the stage's edge, like a
 * gaming setup. Drawn as four strips along the edges (never the whole
 * screen), added to what's below. The rainbow runs around the stage and
 * light chases along the strip.
 */
export const RGB_EDGE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform vec2 u_res;
uniform vec4 u_rect;
uniform float u_time;
uniform float u_amount;
vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
void main() {
  vec2 px = u_rect.xy + v_uv * u_rect.zw;
  float d = min(min(px.x, px.y), min(u_res.x - px.x, u_res.y - px.y));
  vec2 c = px - u_res * 0.5;
  // Once around the stage is 1; whole turns keep the seam invisible.
  float around = atan(c.y, c.x) / 6.28318;
  vec3 col = hue(around * 2.0 - u_time * 0.45);
  float chase = 0.62 + 0.38 * sin(around * 6.28318 * 28.0 - u_time * 14.0);
  float strip = smoothstep(16.0, 3.0, d) * chase;
  float glow = exp(-d / 46.0) * 0.8;
  o = vec4(col * (strip * 1.15 + glow) * u_amount, 0.0);
}`;

/** A laser beam from a point in a direction (ADR-0046): one quad, `u_size` long and wide. */
export const LASER_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
uniform vec2 u_res;
uniform vec2 u_origin;
uniform vec2 u_dir;
uniform vec2 u_size;
out vec2 v_uv;
void main() {
  vec2 n = vec2(-u_dir.y, u_dir.x);
  vec2 p = u_origin + u_dir * a_corner.x * u_size.x + n * (a_corner.y - 0.5) * u_size.y;
  v_uv = a_corner;
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
}`;

export const LASER_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 o;
uniform vec3 u_color;
uniform float u_amount;
void main() {
  float across = abs(v_uv.y - 0.5) * 2.0;
  float core = exp(-across * across * 90.0);
  float halo = exp(-across * 5.0) * 0.3;
  float along = smoothstep(0.0, 0.03, v_uv.x) * pow(1.0 - v_uv.x, 0.7);
  o = vec4((u_color * (core * 0.9 + halo) + vec3(core * 0.5)) * along * u_amount, 0.0);
}`;
