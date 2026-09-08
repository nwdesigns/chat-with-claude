const $ = (s) => document.querySelector(s);
const login = $("#login"),
  chat = $("#chat"),
  messages = $("#messages");
const status = $("#status"),
  textEl = $("#text"),
  sendBtn = $("#send");
const fileInput = $("#file-input"),
  attachList = $("#attach-list");
let pending = [];
let assistantEl = null; // current streaming bubble
let busy = false;
let mode = "global"; // "global" = shared chat, "private" = one chat per login
let myName = "";
let myId = "";

const render = (md) =>
  window.DOMPurify && window.marked
    ? DOMPurify.sanitize(marked.parse(md, { breaks: true }))
    : null;

function bubble(role) {
  const el = document.createElement("article");
  el.className = `msg ${role}`;
  messages.appendChild(el);
  return el;
}
function setMarkdown(el, md) {
  const html = render(md);
  if (html !== null) el.innerHTML = html;
  else el.textContent = md;
  renderPolls(el);
  messages.scrollTop = messages.scrollHeight;
}

// Claude emits questionnaires as ```poll JSON blocks (see the system prompt in
// src/claude.ts). Replace each one with a form: radios or checkboxes per question,
// always an "Other" option with a textarea, one submit that posts `Qn: answer` lines.
const OTHER_LABEL = { en: "Other", it: "Altro" };
function renderPolls(root) {
  root.querySelectorAll("pre > code.language-poll").forEach((code) => {
    let data;
    try {
      data = JSON.parse(code.textContent);
    } catch {
      return; // leave the raw block visible
    }
    const qs = Array.isArray(data?.questions) ? data.questions : [];
    if (!qs.length) return;
    // Claude declares the language in the JSON; fall back to a word check on the bubble.
    const lang =
      data.lang === "it" ||
      (!data.lang &&
        /\b(il|la|le|di|che|per|quali|quale|dove|sito)\b/i.test(
          root.textContent,
        ))
        ? "it"
        : "en";
    const form = document.createElement("form");
    form.className = "poll";
    qs.forEach((q, qi) => {
      const id = String(q.id || `Q${qi + 1}`);
      const multi = q.type === "multi";
      const fs = document.createElement("fieldset");
      fs.dataset.id = id;
      const lg = document.createElement("legend");
      lg.textContent = `${id} · ${q.text || ""}`;
      fs.appendChild(lg);
      const opts = [
        ...(Array.isArray(q.options) ? q.options : []).map(String),
        "__other__",
      ];
      opts.forEach((opt) => {
        const isOther = opt === "__other__";
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = multi ? "checkbox" : "radio";
        input.name = `${id}`;
        input.value = isOther ? "__other__" : opt;
        label.append(input, " ", isOther ? OTHER_LABEL[lang] : opt);
        fs.appendChild(label);
        if (isOther) {
          const ta = document.createElement("textarea");
          ta.rows = 2;
          ta.placeholder =
            lang === "it" ? "Scrivi la tua risposta…" : "Write your answer…";
          ta.hidden = true;
          fs.appendChild(ta);
          // The textarea opens only when "Other" is selected.
          fs.addEventListener("change", () => {
            const on = input.checked;
            ta.hidden = !on;
            if (on) ta.focus();
          });
        }
      });
      form.appendChild(fs);
    });
    const btn = document.createElement("button");
    btn.type = "submit";
    btn.textContent = lang === "it" ? "Invia risposte" : "Send answers";
    form.appendChild(btn);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (busy) return; // wait for the running turn, the form stays open
      const lines = [];
      form.querySelectorAll("fieldset").forEach((fs) => {
        const picked = [...fs.querySelectorAll("input:checked")]
          .map((i) =>
            i.value === "__other__"
              ? fs.querySelector("textarea").value.trim()
              : i.value,
          )
          .filter(Boolean);
        lines.push(
          `${fs.dataset.id}: ${picked.length ? picked.join("; ") : "—"}`,
        );
      });
      textEl.value = lines.join("\n");
      $("#composer").requestSubmit();
      form
        .querySelectorAll("input, textarea, button")
        .forEach((x) => (x.disabled = true));
      form.classList.add("answered");
    });
    code.parentElement.replaceWith(form);
  });
}
function setBusy(b) {
  busy = b;
  status.textContent = b ? "thinking" : "idle";
  status.classList.toggle("busy", b);
  sendBtn.disabled = b;
  if (b) showActivity("Thinking");
  else hideActivity();
}

// Animated activity bubble shown while a turn runs. Always the last node in the list.
const PHRASES = ["Thinking", "Elaborating", "Working on it", "Still thinking"];
let activityEl = null,
  activityTimer = null,
  phraseIdx = 0;
function showActivity(label) {
  if (!activityEl) {
    activityEl = document.createElement("article");
    activityEl.className = "msg activity";
    activityEl.setAttribute("aria-live", "polite");
    const t = document.createElement("span");
    t.className = "label";
    const d = document.createElement("span");
    d.className = "dots";
    for (let i = 0; i < 3; i++) d.appendChild(document.createElement("i"));
    activityEl.append(t, d);
  }
  activityEl.querySelector(".label").textContent = label;
  messages.appendChild(activityEl); // move to the end
  messages.scrollTop = messages.scrollHeight;
  clearInterval(activityTimer);
  phraseIdx = 0;
  // Rotate the phrase every 6 s while nothing else updates the label.
  activityTimer = setInterval(() => {
    phraseIdx = (phraseIdx + 1) % PHRASES.length;
    activityEl.querySelector(".label").textContent = PHRASES[phraseIdx];
  }, 6000);
}
function hideActivity() {
  clearInterval(activityTimer);
  activityEl?.remove();
}

function handle(ev) {
  switch (ev.type) {
    case "user": {
      const el = bubble("user");
      // Shared chat: show who wrote it. Own messages sit on the right, others on the left.
      if (mode === "global" && ev.name) {
        // Ownership by participant id, not by name: two people can pick the same name.
        if (ev.id !== myId) el.classList.add("other");
        const who = document.createElement("div");
        who.className = "author";
        who.textContent = ev.name;
        el.appendChild(who);
      }
      if (ev.voice) {
        const v = document.createElement("div");
        v.className = "voice";
        v.textContent = "voice message";
        el.appendChild(v);
      }
      el.appendChild(document.createTextNode(ev.text));
      if (ev.attachments?.length) {
        const a = document.createElement("div");
        a.className = "attachments";
        a.textContent = "Attachments: " + ev.attachments.join(", ");
        el.appendChild(a);
      }
      assistantEl = null;
      setBusy(true);
      break;
    }
    case "text": {
      if (!assistantEl) {
        assistantEl = bubble("assistant");
        assistantEl.dataset.md = "";
      }
      assistantEl.dataset.md +=
        (assistantEl.dataset.md ? "\n\n" : "") + ev.text;
      setMarkdown(assistantEl, assistantEl.dataset.md);
      if (busy) showActivity("Thinking"); // keep the bubble below the streamed text
      break;
    }
    case "tool_use": {
      const el = bubble("tool");
      const input = ev.input && typeof ev.input === "object" ? ev.input : {};
      const hint =
        input.command || input.file_path || input.pattern || input.url || "";
      el.textContent = `🔧 ${ev.name}${hint ? ": " + String(hint).slice(0, 160) : ""}`;
      assistantEl = null; // next text starts a new bubble
      if (busy) showActivity(`Running ${ev.name}`);
      break;
    }
    case "tool_result":
      if (busy) showActivity("Elaborating");
      break;
    case "error": {
      const el = bubble("error");
      el.textContent = "⚠ " + ev.message;
      break;
    }
    case "done":
      setBusy(false);
      break;
    case "result":
      if (ev.isError && ev.text) {
        const el = bubble("error");
        el.textContent = "⚠ " + ev.text;
      }
      break;
  }
  messages.scrollTop = messages.scrollHeight;
}

let pollGen = 0;
async function poll(since) {
  const gen = ++pollGen;
  while (gen === pollGen) {
    try {
      const r = await fetch(`/api/poll?since=${since}`);
      if (r.status === 401) {
        boot();
        return;
      }
      const j = await r.json();
      for (const ev of j.events) handle(ev);
      since = j.next;
      if (!busy) setBusy(false); // clears a stale "reconnecting" label
    } catch {
      status.textContent = "reconnecting";
      await new Promise((f) => setTimeout(f, 2000));
    }
  }
}

async function boot() {
  const r = await fetch("/api/state");
  if (r.status === 401) {
    login.hidden = false;
    chat.hidden = true;
    return;
  }
  const s = await r.json();
  login.hidden = true;
  chat.hidden = false;
  mode = s.mode || "global"; // older servers send no mode
  myName = s.name || "";
  myId = s.id || "";
  const modeLabel = mode === "private" ? "private chat" : "shared chat";
  const session = s.live ? "LIVE session" : "forked session";
  $("#meta").textContent =
    `${s.cwd} · ${session} · ${modeLabel}${myName ? " · " + myName : ""}`;
  messages.innerHTML = "";
  for (const ev of s.history) handle(ev);
  setBusy(s.busy);
  poll(s.history.length);
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: $("#name").value.trim(),
      password: $("#password").value,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    err.hidden = false;
    err.textContent =
      j.lockedMs > 0
        ? `Locked. Try again in ${Math.ceil(j.lockedMs / 1000)} s.`
        : "Wrong password.";
    return;
  }
  err.hidden = true;
  boot();
});

function renderAttachList() {
  attachList.innerHTML = "";
  pending.forEach((f, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = f.voiceSeconds
      ? `voice message ${f.voiceSeconds}s ✕`
      : `${f.name} (${(f.size / 1048576).toFixed(1)} MB) ✕`;
    chip.onclick = () => {
      pending.splice(i, 1);
      renderAttachList();
    };
    attachList.appendChild(chip);
  });
}
function addFiles(list) {
  for (const f of list) {
    if (f.size > 200 * 1048576) {
      alert(`${f.name} exceeds 200 MB`);
      continue;
    }
    pending.push(f);
  }
  renderAttachList();
}
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("drag");
});
document.addEventListener("dragleave", () =>
  document.body.classList.remove("drag"),
);
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("drag");
  if (!chat.hidden) addFiles(e.dataTransfer.files);
});
document.addEventListener("paste", (e) => {
  const fs = [...(e.clipboardData?.files ?? [])];
  if (fs.length) addFiles(fs);
});

// Voice messages: MediaRecorder → one audio file named voice-*.<ext>. The server
// transcribes files with that prefix and sends Claude the text.
const micBtn = $("#mic");
let recorder = null,
  recStart = 0,
  recTimer = null;
async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    alert("This browser cannot record audio.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert("Microphone access was denied.");
    return;
  }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
    MediaRecorder.isTypeSupported(m),
  );
  // Keep a local handle: stopRecording() clears `recorder` before onstop fires.
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder = rec;
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const type = rec.mimeType || mime || "audio/webm";
    const ext = type.includes("mp4")
      ? "m4a"
      : type.includes("ogg")
        ? "ogg"
        : "webm";
    const secs = Math.round((Date.now() - recStart) / 1000);
    const file = new File(chunks, `voice-${Date.now()}.${ext}`, { type });
    if (secs < 1 || file.size === 0) {
      status.textContent = "too short"; // a tap, not a message
      return;
    }
    file.voiceSeconds = secs;
    addFiles([file]);
  };
  rec.start();
  recStart = Date.now();
  micBtn.classList.add("recording");
  micBtn.setAttribute("aria-pressed", "true");
  micBtn.title = "Stop recording";
  // While recording the icon gives way to a timer.
  micBtn.querySelector(".mic-icon").hidden = true;
  const time = micBtn.querySelector(".rec-time");
  time.hidden = false;
  time.textContent = "0:00";
  recTimer = setInterval(() => {
    const s = Math.round((Date.now() - recStart) / 1000);
    time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);
}
function stopRecording() {
  clearInterval(recTimer);
  micBtn.classList.remove("recording");
  micBtn.setAttribute("aria-pressed", "false");
  micBtn.title = "Record a voice message";
  micBtn.querySelector(".mic-icon").hidden = false;
  micBtn.querySelector(".rec-time").hidden = true;
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recorder = null;
}
micBtn.addEventListener("click", () => {
  if (recorder) stopRecording();
  else startRecording();
});

textEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});
textEl.addEventListener("input", () => {
  textEl.style.height = "auto";
  textEl.style.height = Math.min(textEl.scrollHeight, 200) + "px";
});

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;
  if (recorder) stopRecording(); // a click on Send while recording ends the recording; send again
  const text = textEl.value.trim();
  if (!text && pending.length === 0) return;
  const fd = new FormData();
  fd.append("text", text);
  for (const f of pending) fd.append("files", f, f.name);
  sendBtn.disabled = true;
  status.textContent = pending.some((f) => f.voiceSeconds)
    ? "transcribing"
    : pending.length
      ? "uploading"
      : "sending";
  const r = await fetch("/api/send", { method: "POST", body: fd });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const el = bubble("error");
    el.textContent = "⚠ " + (j.error || r.statusText);
    sendBtn.disabled = false;
    status.textContent = "idle";
    if (r.status === 401) boot();
    return;
  }
  textEl.value = "";
  textEl.style.height = "auto";
  pending = [];
  renderAttachList();
});

boot();
