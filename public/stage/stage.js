// Stage renderer: draws the host character, performs speech cues, shows
// captions and alerts. Runs as an OBS browser source (1080x1920).
//
// ?preview=1  muted copy that never reports playback (for the control panel).

const W = 1080;
const H = 1920;
const ORB = { x: 540, y: 720, r: 165 };

const params = new URLSearchParams(location.search);
const isPreview = params.get("preview") === "1";

const frame = document.getElementById("frame");
const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const captionEl = document.getElementById("caption");
const segmentEl = document.getElementById("segment");
const disclosureEl = document.getElementById("disclosure");
const alertsEl = document.getElementById("alerts");
const unmuteEl = document.getElementById("unmute");

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const look = {
  mode: "orb",
  primary: "#7cf5ff",
  secondary: "#ff5fd2",
  background: "#0b0420",
  offering: "#ffd15c",
};

const state = {
  emotion: "neutral",
  emotionUntil: 0,
  amp: 0,
  bounceY: 0,
  bounceV: 0,
  flash: 0,
  rings: [],
  offerings: [],
  motes: [],
  eye: { x: 0, y: 0, tx: 0, ty: 0, nextGlance: 0 },
  blink: { start: -1, next: 0 },
};

// ---------------------------------------------------------------- layout --

function fit() {
  const scale = Math.min(innerWidth / W, innerHeight / H);
  frame.style.setProperty("--fit", String(scale));
}
addEventListener("resize", fit);
fit();

// ----------------------------------------------------------------- color --

function rgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex, a) {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function mix(a, b, t) {
  const ca = rgb(a);
  const cb = rgb(b);
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  // Hex output so results can be mixed again.
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// ----------------------------------------------------------------- audio --

let audioCtx;
let analyser;
let output;
const sample = new Float32Array(1024);

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    output = audioCtx.createGain();
    output.gain.value = isPreview ? 0 : 1;
    analyser.connect(output).connect(audioCtx.destination);
  }
  unmuteEl.hidden = isPreview || audioCtx.state === "running";
  return audioCtx;
}

unmuteEl.addEventListener("click", async () => {
  await ensureAudio().resume();
  unmuteEl.hidden = true;
});

// ---------------------------------------------------------------- speech --

let current = null;
let caption = null;
let captionFadeTimer;

async function speak(cue) {
  stopCurrent();
  const token = { id: cue.id, cancelled: false, source: null, timer: 0, simulated: false };
  current = token;
  setEmotion(cue.emotion, 0);

  let duration = cue.durationMs;
  let buffer = null;
  if (cue.audioUrl) {
    try {
      const ac = ensureAudio();
      const response = await fetch(cue.audioUrl);
      buffer = await ac.decodeAudioData(await response.arrayBuffer());
      duration = buffer.duration * 1000;
    } catch (err) {
      console.warn("audio failed, showing captions only", err);
      buffer = null;
    }
  }
  if (token.cancelled) return;

  showCaption(cue.text, duration);
  if (buffer && audioCtx.state === "running") {
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    source.onended = () => finish(token);
    token.source = source;
    source.start();
  } else {
    token.simulated = true;
    token.timer = setTimeout(() => finish(token), duration);
  }
}

function finish(token) {
  if (current !== token || token.cancelled) return;
  current = null;
  state.emotionUntil = performance.now() + 2500;
  captionFadeTimer = setTimeout(() => captionEl.classList.add("fading"), 1600);
  if (!isPreview) send({ type: "spoken", id: token.id });
}

function stopCurrent() {
  if (!current) return;
  current.cancelled = true;
  try {
    current.source?.stop();
  } catch {
    // already stopped
  }
  clearTimeout(current.timer);
  current = null;
}

function showCaption(text, duration) {
  clearTimeout(captionFadeTimer);
  captionEl.classList.remove("fading");
  captionEl.replaceChildren();
  const words = text.split(/\s+/).filter(Boolean);
  const spans = words.map((word, i) => {
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = word;
    captionEl.append(span);
    if (i < words.length - 1) captionEl.append(" ");
    return span;
  });
  caption = { spans, start: performance.now(), duration: Math.max(duration, 400) };
}

function updateCaption(now) {
  if (!caption) return;
  const progress = Math.min(1, (now - caption.start) / caption.duration);
  // Weight by characters so long words take longer, like speech does.
  const lengths = caption.spans.map((s) => s.textContent.length + 1);
  const total = lengths.reduce((a, b) => a + b, 0);
  let acc = 0;
  caption.spans.forEach((span, i) => {
    const startAt = acc / total;
    acc += lengths[i];
    const endAt = acc / total;
    span.classList.toggle("said", progress >= endAt);
    span.classList.toggle("now", progress >= startAt && progress < endAt);
  });
}

function currentAmplitude(now) {
  if (!current) return 0;
  if (current.source && analyser) {
    analyser.getFloatTimeDomainData(sample);
    let sum = 0;
    for (const v of sample) sum += v * v;
    return Math.min(1, Math.sqrt(sum / sample.length) * 4.5);
  }
  // No audio: fake a syllable rhythm so the character still talks.
  const t = now / 1000;
  return 0.25 + 0.55 * Math.abs(Math.sin(t * 12.5)) * (0.6 + 0.4 * Math.sin(t * 3.3));
}

// ---------------------------------------------------------------- events --

function setEmotion(emotion, holdMs) {
  state.emotion = emotion || "neutral";
  state.emotionUntil = holdMs ? performance.now() + holdMs : Infinity;
}

function kick(strength) {
  if (reducedMotion) return;
  state.bounceV -= strength;
}

function addAlert(message) {
  const li = document.createElement("li");
  li.className = message.kind;
  const name = document.createElement("span");
  name.textContent = message.name;
  const strong = document.createElement("strong");
  if (message.kind === "gift") {
    strong.textContent = message.count > 1 ? `${message.count} ${message.giftName}` : message.giftName;
    li.append(name, " sent ", strong);
  } else if (message.kind === "follow") {
    strong.textContent = "followed";
    li.append(name, " ", strong);
  } else {
    strong.textContent = "shared the stream";
    li.append(name, " ", strong);
  }
  alertsEl.prepend(li);
  while (alertsEl.children.length > 4) alertsEl.lastElementChild.remove();
  setTimeout(() => li.classList.add("leaving"), 6000);
  setTimeout(() => li.remove(), 6700);

  if (message.kind === "gift") {
    const motes = Math.min(36, 4 + Math.round(Math.log10(message.diamonds + 1) * 7));
    for (let i = 0; i < motes; i++) {
      state.offerings.push({
        x: 820 + Math.random() * 140,
        y: 420 + Math.random() * 120,
        delay: i * 45,
        t: 0,
        speed: 0.012 + Math.random() * 0.008,
        bend: (Math.random() - 0.5) * 260,
        big: message.diamonds >= 1000,
      });
    }
    state.eye.tx = 0.7;
    state.eye.ty = -0.4;
  } else {
    state.rings.push({ r: ORB.r, alpha: 0.7 });
    kick(4);
  }
}

function applyConfig(config) {
  Object.assign(look, config.visual ?? {});
  document.documentElement.style.setProperty("--abyss", look.background);
  document.documentElement.style.setProperty("--glow", look.primary);
  document.documentElement.style.setProperty("--bloom", look.secondary);
  disclosureEl.textContent = `${config.name} is an AI host`;
}

function handle(message) {
  switch (message.type) {
    case "config":
      applyConfig(message);
      break;
    case "speak":
      void speak(message);
      break;
    case "stop":
      stopCurrent();
      captionEl.classList.add("fading");
      break;
    case "alert":
      addAlert(message);
      break;
    case "segment":
      if (segmentEl.textContent !== message.title) {
        segmentEl.textContent = message.title;
        segmentEl.classList.remove("changed");
        void segmentEl.offsetWidth; // restart the animation
        segmentEl.classList.add("changed");
      }
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------- transport --

let socket;
function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/ws/stage${location.search}`);
  socket.onmessage = (event) => {
    try {
      handle(JSON.parse(event.data));
    } catch (err) {
      console.warn("bad message", err);
    }
  };
  socket.onclose = () => setTimeout(connect, 1500);
}

// ----------------------------------------------------------------- scene --

for (let i = 0; i < 70; i++) {
  state.motes.push({
    x: Math.random() * W,
    y: Math.random() * H,
    r: 1.5 + Math.random() * 3.5,
    speed: 6 + Math.random() * 18,
    phase: Math.random() * Math.PI * 2,
    alpha: 0.15 + Math.random() * 0.45,
  });
}

function drawWater(t) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, mix(look.background, look.primary, 0.1));
  bg.addColorStop(0.45, look.background);
  bg.addColorStop(1, mix(look.background, "#000000", 0.35));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Slow light shafts from the surface.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 4; i++) {
    const sway = Math.sin(t * 0.15 + i * 1.7) * 90;
    const x = 160 + i * 250 + sway;
    const shaft = ctx.createLinearGradient(x, 0, x + 260, H * 0.75);
    shaft.addColorStop(0, rgba(look.primary, 0.06));
    shaft.addColorStop(1, rgba(look.primary, 0));
    ctx.fillStyle = shaft;
    ctx.beginPath();
    ctx.moveTo(x - 50, 0);
    ctx.lineTo(x + 70, 0);
    ctx.lineTo(x + 330, H * 0.75);
    ctx.lineTo(x + 150, H * 0.75);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawMotes(dt, t) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const m of state.motes) {
    if (!reducedMotion) {
      m.y -= m.speed * dt * (1 + state.amp * 1.5);
      m.x += Math.sin(t * 0.6 + m.phase) * 0.25;
      if (m.y < -10) {
        m.y = H + 10;
        m.x = Math.random() * W;
      }
    }
    const near = Math.max(0, 1 - Math.hypot(m.x - ORB.x, m.y - ORB.y) / 520);
    ctx.fillStyle = rgba(look.primary, Math.min(1, m.alpha + near * state.amp * 0.6));
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawOfferings(dt, cy) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const o of state.offerings) {
    if (o.delay > 0) {
      o.delay -= dt * 1000;
      continue;
    }
    o.t = Math.min(1, o.t + o.speed * dt * 60);
    const e = o.t * o.t * (3 - 2 * o.t);
    const x = o.x + (ORB.x - o.x) * e + Math.sin(e * Math.PI) * o.bend;
    const y = o.y + (cy - o.y) * e;
    const size = (o.big ? 9 : 6) * (1 - e * 0.6);
    const glow = ctx.createRadialGradient(x, y, 0, x, y, size * 4);
    glow.addColorStop(0, rgba(look.offering, 0.95));
    glow.addColorStop(1, rgba(look.offering, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, size * 4, 0, Math.PI * 2);
    ctx.fill();
    if (o.t >= 1) {
      o.done = true;
      state.flash = Math.min(1.4, state.flash + (o.big ? 0.25 : 0.12));
      kick(o.big ? 3 : 1.2);
    }
  }
  ctx.restore();
  const before = state.offerings.length;
  state.offerings = state.offerings.filter((o) => !o.done);
  if (before && !state.offerings.length && !current) setEmotion("excited", 1800);
}

function orbPath(cx, cy, r, t, amp, squash) {
  ctx.beginPath();
  const steps = 72;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wobble =
      1 +
      0.025 * Math.sin(3 * a + t * 1.7) +
      0.018 * Math.sin(2 * a - t * 1.1) +
      amp * 0.055 * Math.sin(5 * a + t * 7);
    const x = cx + Math.cos(a) * r * wobble * (1 + squash);
    const y = cy + Math.sin(a) * r * wobble * (1 - squash);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawEye(x, y, r, emotion, blinkScale, side) {
  const ink = look.background;
  const w = r * 0.13;
  const h = r * 0.2 * blinkScale;
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineWidth = r * 0.065;

  const highlight = (hx, hy, size) => {
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(hx, hy, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ink;
  };

  switch (emotion) {
    case "happy":
    case "laugh":
      ctx.beginPath();
      ctx.arc(x, y + w * 0.6, w * 1.05, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
      return;
    case "love": {
      const s = w * 1.25;
      ctx.beginPath();
      ctx.moveTo(x, y + s * 0.9);
      ctx.bezierCurveTo(x - s * 1.6, y - s * 0.1, x - s * 0.7, y - s * 1.3, x, y - s * 0.4);
      ctx.bezierCurveTo(x + s * 0.7, y - s * 1.3, x + s * 1.6, y - s * 0.1, x, y + s * 0.9);
      ctx.fill();
      return;
    }
    case "mischief":
      ctx.beginPath();
      ctx.ellipse(x, y + h * 0.15, w, h * 0.6, 0, 0, Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - w * 1.3, y - h * 0.1 + side * w * 0.3);
      ctx.lineTo(x + w * 1.3, y - h * 0.1 - side * w * 0.3);
      ctx.stroke();
      return;
    case "sad":
      ctx.beginPath();
      ctx.ellipse(x, y + h * 0.15, w * 0.9, h * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      highlight(x + w * 0.3, y - h * 0.2, w * 0.28);
      ctx.beginPath();
      ctx.moveTo(x - w * 1.2 * side, y - h * 0.95);
      ctx.lineTo(x + w * 1.1 * side, y - h * 0.7);
      ctx.stroke();
      return;
    case "surprised":
      ctx.beginPath();
      ctx.ellipse(x, y, w * 1.3, Math.max(1, h * 1.1), 0, 0, Math.PI * 2);
      ctx.fill();
      highlight(x + w * 0.45, y - h * 0.35, w * 0.38);
      return;
    case "excited":
      ctx.beginPath();
      ctx.ellipse(x, y, w * 1.15, Math.max(1, h * 1.1), 0, 0, Math.PI * 2);
      ctx.fill();
      highlight(x + w * 0.4, y - h * 0.35, w * 0.4);
      highlight(x - w * 0.35, y + h * 0.3, w * 0.18);
      return;
    default:
      ctx.beginPath();
      ctx.ellipse(x, y, w, Math.max(1, h), 0, 0, Math.PI * 2);
      ctx.fill();
      if (blinkScale > 0.5) highlight(x + w * 0.35, y - h * 0.3, w * 0.3);
  }
}

function drawMouth(cx, cy, r, emotion, amp, talking) {
  const ink = look.background;
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = r * 0.05;
  ctx.lineCap = "round";
  if (talking) {
    const w = r * (0.1 + amp * 0.08);
    const h = r * (0.025 + amp * 0.17);
    ctx.beginPath();
    ctx.ellipse(cx, cy + h * 0.4, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  switch (emotion) {
    case "sad":
      ctx.arc(cx, cy + r * 0.12, r * 0.09, Math.PI * 1.2, Math.PI * 1.8);
      ctx.stroke();
      break;
    case "surprised":
      ctx.ellipse(cx, cy + r * 0.03, r * 0.045, r * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "mischief":
      ctx.moveTo(cx - r * 0.09, cy + r * 0.01);
      ctx.quadraticCurveTo(cx + r * 0.02, cy + r * 0.07, cx + r * 0.11, cy - r * 0.04);
      ctx.stroke();
      break;
    case "thinking":
      ctx.moveTo(cx - r * 0.06, cy + r * 0.03);
      ctx.lineTo(cx + r * 0.06, cy + r * 0.01);
      ctx.stroke();
      break;
    default:
      ctx.arc(cx, cy - r * 0.04, r * 0.09, Math.PI * 0.2, Math.PI * 0.8);
      ctx.stroke();
  }
}

function drawOrb(now, t, dt) {
  // Spring bounce + idle bob.
  state.bounceV += -state.bounceY * 0.12;
  state.bounceV *= 0.86;
  state.bounceY += state.bounceV;
  const bob = reducedMotion ? 0 : Math.sin(t * 1.3) * 14;
  const cx = ORB.x;
  const cy = ORB.y + bob + state.bounceY * 6;
  const amp = state.amp;
  const r = ORB.r * (1 + amp * 0.05 + state.flash * 0.04);
  const squash = Math.max(-0.08, Math.min(0.08, state.bounceV * 0.012));
  const tint = state.emotion === "sad" ? 0.35 : 0;

  // Glow.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2.6);
  glow.addColorStop(0, rgba(look.primary, 0.32 + amp * 0.3 + state.flash * 0.2));
  glow.addColorStop(0.5, rgba(look.secondary, 0.1 + amp * 0.08));
  glow.addColorStop(1, rgba(look.primary, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(cx - r * 2.6, cy - r * 2.6, r * 5.2, r * 5.2);
  if (state.flash > 0.01) {
    const gold = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 2);
    gold.addColorStop(0, rgba(look.offering, Math.min(0.6, state.flash * 0.5)));
    gold.addColorStop(1, rgba(look.offering, 0));
    ctx.fillStyle = gold;
    ctx.fillRect(cx - r * 2, cy - r * 2, r * 4, r * 4);
  }
  ctx.restore();

  // Rings (follows / shares).
  for (const ring of state.rings) {
    ring.r += 260 * dt;
    ring.alpha -= 0.55 * dt;
    ctx.strokeStyle = rgba(look.primary, Math.max(0, ring.alpha));
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  state.rings = state.rings.filter((ring) => ring.alpha > 0);

  // Body.
  const body = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.05, cx, cy, r * 1.05);
  body.addColorStop(0, "#ffffff");
  body.addColorStop(0.28, mix(look.primary, "#808080", tint));
  body.addColorStop(0.82, mix(mix(look.primary, look.secondary, 0.65), "#808080", tint));
  body.addColorStop(1, mix(look.secondary, "#808080", tint));
  ctx.fillStyle = body;
  orbPath(cx, cy, r, t, amp, squash);
  ctx.fill();

  // Gloss.
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.38, cy - r * 0.5, r * 0.2, r * 0.1, -0.6, 0, Math.PI * 2);
  ctx.fill();

  // Eyes wander a little, and look toward incoming gifts.
  const eye = state.eye;
  if (now > eye.nextGlance) {
    eye.tx = (Math.random() - 0.5) * 0.8;
    eye.ty = (Math.random() - 0.5) * 0.5;
    if (state.emotion === "thinking") {
      eye.tx = 0.6;
      eye.ty = -0.7;
    }
    eye.nextGlance = now + 2500 + Math.random() * 4000;
  }
  eye.x += (eye.tx - eye.x) * 0.08;
  eye.y += (eye.ty - eye.y) * 0.08;

  const blink = state.blink;
  if (blink.start < 0 && now > blink.next) blink.start = now;
  let blinkScale = 1;
  if (blink.start >= 0) {
    const p = (now - blink.start) / 150;
    if (p >= 1) {
      blink.start = -1;
      blink.next = now + 2500 + Math.random() * 3500;
    } else {
      blinkScale = 1 - Math.sin(p * Math.PI) * 0.92;
    }
  }

  const ex = eye.x * r * 0.08;
  const ey = eye.y * r * 0.08 - r * 0.08;
  drawEye(cx - r * 0.32 + ex, cy + ey, r, state.emotion, blinkScale, -1);
  drawEye(cx + r * 0.32 + ex, cy + ey, r, state.emotion, blinkScale, 1);

  if (["happy", "love", "laugh", "excited"].includes(state.emotion)) {
    ctx.fillStyle = rgba(look.secondary, 0.45);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + side * r * 0.5 + ex, cy + r * 0.15, r * 0.12, r * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawMouth(cx + ex * 0.5, cy + r * 0.3, r, state.emotion, amp, Boolean(current));
}

function drawVoiceLine(t) {
  const y = ORB.y;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const [color, width, alpha] of [
    [look.secondary, 18, 0.18],
    [look.primary, 6, 0.95],
  ]) {
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let x = 160; x <= 920; x += 8) {
      const edge = Math.sin(((x - 160) / 760) * Math.PI);
      const wave =
        Math.sin(x * 0.02 + t * 6) * 0.6 + Math.sin(x * 0.045 - t * 9) * 0.4;
      const yy = y + wave * edge * (8 + state.amp * 120);
      if (x === 160) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.restore();
}

let last = performance.now();
function frameLoop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;

  state.amp += (currentAmplitude(now) - state.amp) * 0.35;
  state.flash = Math.max(0, state.flash - dt * 0.9);
  if (!current && now > state.emotionUntil && state.emotion !== "neutral") state.emotion = "neutral";

  drawWater(t);
  drawMotes(dt, t);
  if (look.mode === "none") {
    drawVoiceLine(t);
    drawOfferings(dt, ORB.y);
  } else {
    drawOfferings(dt, ORB.y);
    drawOrb(now, t, dt);
  }
  updateCaption(now);
  requestAnimationFrame(frameLoop);
}

if (!isPreview) ensureAudio();
connect();
requestAnimationFrame(frameLoop);
