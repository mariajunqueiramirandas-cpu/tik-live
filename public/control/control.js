// Operator control panel: watch the show, hit the kill switch, steer segments,
// and inject test events.

const token = new URLSearchParams(location.search).get("token") ?? "";
const $ = (id) => document.getElementById(id);

let socket;
let paused = false;

function send(command) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
}

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  socket = new WebSocket(`${scheme}://${location.host}/ws/control${query}`);
  socket.onmessage = (event) => handle(JSON.parse(event.data));
  socket.onclose = () => {
    setStatus("offline", "Lost connection to the engine", "Reconnecting…");
    setTimeout(connect, 2000);
  };
}

function time(at) {
  const el = document.createElement("time");
  el.textContent = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return el;
}

function prependCapped(list, item, cap) {
  list.prepend(item);
  while (list.children.length > cap) list.lastElementChild.remove();
}

function setStatus(kind, title, detail) {
  $("status-dot").className = `dot ${kind}`;
  $("status-title").textContent = title;
  $("status-detail").textContent = detail;
}

function handle(message) {
  switch (message.type) {
    case "state":
      renderState(message.state);
      break;
    case "spoken": {
      const li = document.createElement("li");
      li.append(time(message.at), message.text);
      prependCapped($("transcript"), li, 200);
      break;
    }
    case "blocked": {
      const li = document.createElement("li");
      li.className = "blocked";
      const why = document.createElement("em");
      why.textContent = ` (blocked: ${message.reason})`;
      li.append(time(message.at), message.text, why);
      prependCapped($("transcript"), li, 200);
      break;
    }
    case "log": {
      const li = document.createElement("li");
      li.className = message.level;
      li.append(time(message.at), `[${message.scope}] ${message.msg}`);
      prependCapped($("log"), li, 300);
      break;
    }
    default:
      break;
  }
}

function renderState(s) {
  const d = s.director;
  if (!d) return;
  paused = d.paused;

  if (d.paused) setStatus("paused", "Host paused", "Nothing will be said until you resume.");
  else if (d.standby) setStatus("", "Standing by", "Waiting for the TikTok stream to go live.");
  else if (d.turnInFlight) setStatus("live", "On air", "Thinking about what to say…");
  else setStatus("live", "On air", s.nowPlaying ? "Talking" : "Listening to chat");

  const pause = $("pause");
  pause.textContent = d.paused ? "Resume host" : "Pause host";
  pause.classList.toggle("resume", d.paused);

  $("viewers").textContent = d.stats.viewers.toLocaleString();
  $("likes").textContent = d.stats.likes.toLocaleString();
  $("uptime").textContent = d.stats.uptimeMinutes.toLocaleString();
  $("now-playing").textContent = s.nowPlaying ?? "Nothing right now.";

  const remaining = d.segmentEndsInSec;
  $("segment-detail").textContent = `${d.segment.title}, next segment in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  const segments = $("segments");
  if (segments.children.length !== s.segments.length) {
    segments.replaceChildren(
      ...s.segments.map((seg) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.id = seg.id;
        button.textContent = seg.title;
        button.addEventListener("click", () => send({ type: "segment", id: seg.id }));
        return button;
      }),
    );
  }
  for (const button of segments.children) {
    button.setAttribute("aria-pressed", String(button.dataset.id === d.segment.id));
  }

  $("queue").replaceChildren(
    ...s.queue.map((item) => {
      const li = document.createElement("li");
      const kind = document.createElement("span");
      kind.className = `kind ${item.kind}`;
      kind.textContent = item.kind;
      const body = document.createElement("span");
      body.textContent = item.text ? `${item.who}: ${item.text}` : item.who;
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = item.priority;
      li.append(kind, body, score);
      return li;
    }),
  );

  const dropped = Object.entries(s.dropped)
    .filter(([reason]) => !reason.startsWith("not queueable") && !reason.startsWith("join from"))
    .map(([reason, count]) => `${count} ${reason}`);
  $("dropped").textContent = dropped.length ? `Filtered out: ${dropped.join(", ")}` : "";

  const health = [
    ["Audience", `${s.source.name}: ${s.source.detail}`, !s.source.connected],
    [
      "OBS",
      s.obs
        ? s.obs.connected
          ? `${s.obs.streaming ? "Streaming" : "Not streaming"}${s.obs.congestion ? `, congestion ${(s.obs.congestion * 100).toFixed(0)}%` : ""}`
          : s.obs.detail
        : "Not managed (set OBS_WS_URL)",
      s.obs ? !s.obs.streaming : false,
    ],
    [
      "Stage",
      s.stages.primary
        ? `${s.stages.primary} OBS source connected`
        : "No OBS source connected; speech is paced by estimate",
      !s.stages.primary,
    ],
    ["Brain", `${s.brain.host}${s.brain.moderator ? " + moderator" : ", rules-only safety"}`, false],
    ["Voice", s.brain.tts === "none" ? "Captions only (no TTS)" : s.brain.tts, false],
    ["Memory", `${s.viewersRemembered.toLocaleString()} viewers remembered`, false],
  ];
  $("health").replaceChildren(
    ...health.flatMap(([label, value, bad]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      if (bad) dd.className = "bad";
      return [dt, dd];
    }),
  );
}

$("pause").addEventListener("click", () => send({ type: paused ? "resume" : "pause" }));
$("skip").addEventListener("click", () => send({ type: "skip" }));

$("say-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("say-input");
  const text = input.value.trim();
  if (!text) return;
  send({ type: "say", text });
  input.value = "";
});

$("inject-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const kind = $("inject-kind").value;
  const handle = $("inject-handle").value.trim() || "test_viewer";
  const text = $("inject-text").value.trim();
  const count = Number($("inject-count").value) || 1;
  if (kind === "chat" && !text) return;
  send({
    type: "inject",
    event: kind === "gift" ? { kind, handle, giftName: text || "Rose", count, diamonds: 1 } : { kind, handle, text },
  });
  if (kind === "chat") $("inject-text").value = "";
});

connect();
