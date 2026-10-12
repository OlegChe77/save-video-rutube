// Download bar under the Rutube player.
"use strict";

let currentId = null;
let info = null; // video info from background, for the quality menu
let jobs = [];
let pref = QUALITY_DEFAULT;

browser.storage.local.get("quality").then((s) => {
  pref = s.quality || QUALITY_DEFAULT;
  render();
});

const port = browser.runtime.connect({ name: "ui" });
port.onMessage.addListener((msg) => {
  if (msg.type === "jobs") {
    jobs = msg.jobs;
    render();
  }
});

// The main player is the longest video on the page (ads are short).
function player() {
  let best = null;
  for (const v of document.querySelectorAll("video")) {
    const d = isFinite(v.duration) ? v.duration : 0;
    if (!best || d > (isFinite(best.duration) ? best.duration : 0)) best = v;
  }
  return best;
}

function videoId() {
  const m = location.pathname.match(/^\/(?:video(?:\/private)?|shorts)\/([0-9a-f]{32})/);
  return m ? m[1] : null;
}

function videoTitle() {
  const h = document.querySelector('h1[class*="videopage-description-module__title"]') || document.querySelector("main h1, h1");
  return (h && h.textContent.trim()) || document.title.replace(/ - смотреть видео.*$/, "");
}

// ---------- building ----------

function buildBar() {
  const btn = (cls, name, text, title) => h("button", { className: cls, title }, icon(name), text && h("span", null, text));
  const ring = document.createElementNS(SVG_NS, "svg");
  ring.setAttribute("class", "rtdl-ring");
  ring.setAttribute("viewBox", "0 0 36 36");
  for (const cls of ["", "rtdl-ring-fill"]) {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", "18");
    c.setAttribute("cy", "18");
    c.setAttribute("r", "15");
    if (cls) c.setAttribute("class", cls);
    ring.append(c);
  }
  const nowTitle = "Взять текущее время видео";

  const bar = h("div", { id: "rtdl-bar" },
    h("div", { className: "rtdl-row" },
      h("div", { className: "rtdl-split" },
        h("button", { className: "rtdl-main", title: "Скачать видео" }, icon("download"), h("span", null, "Скачать"), h("b", { className: "rtdl-q" })),
        btn("rtdl-caret", "chevron", "", "Выбрать качество"),
        h("div", { className: "rtdl-menu", hidden: true })),
      btn("rtdl-ghost rtdl-clip-toggle", "scissors", "Отрывок", "Скачать только часть видео"),
      btn("rtdl-ghost rtdl-frame", "camera", "Кадр", "Сохранить текущий кадр в PNG"),
      h("div", { className: "rtdl-job", hidden: true },
        ring,
        h("span", { className: "rtdl-job-text" }),
        h("button", { className: "rtdl-icon rtdl-job-act" }))),
    h("div", { className: "rtdl-clip", hidden: true },
      h("label", null, "Начало ", h("input", { className: "rtdl-from", spellcheck: false })),
      btn("rtdl-icon rtdl-from-now", "pin", "", nowTitle),
      h("span", { className: "rtdl-dash" }),
      h("label", null, "Конец ", h("input", { className: "rtdl-to", spellcheck: false })),
      btn("rtdl-icon rtdl-to-now", "pin", "", nowTitle),
      h("span", { className: "rtdl-clip-len" }),
      btn("rtdl-clip-go", "download", "Скачать отрывок")));

  const $ = (s) => bar.querySelector(s);
  const menu = $(".rtdl-menu");

  $(".rtdl-main").onclick = () => download();
  $(".rtdl-caret").onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) renderMenu();
  };
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
  });

  $(".rtdl-clip-toggle").onclick = () => {
    const panel = $(".rtdl-clip");
    panel.hidden = !panel.hidden;
    $(".rtdl-clip-toggle").classList.toggle("rtdl-on", !panel.hidden);
    if (!panel.hidden) {
      const v = player();
      const t = v ? v.currentTime : 0;
      const dur = v && isFinite(v.duration) ? v.duration : t + 30;
      $(".rtdl-from").value = fmtTime(t);
      $(".rtdl-to").value = fmtTime(Math.min(dur, t + 30));
      updateClipLen();
    }
  };
  const setNow = (input) => () => {
    const v = player();
    if (v) input.value = fmtTime(v.currentTime);
    updateClipLen();
  };
  $(".rtdl-from-now").onclick = setNow($(".rtdl-from"));
  $(".rtdl-to-now").onclick = setNow($(".rtdl-to"));
  $(".rtdl-from").oninput = $(".rtdl-to").oninput = updateClipLen;
  $(".rtdl-clip-go").onclick = () => {
    const clip = readClip();
    if (clip) download(clip);
  };

  // Player hotkeys must not fire while typing time
  for (const input of bar.querySelectorAll("input")) {
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") $(".rtdl-clip-go").click();
    });
  }

  $(".rtdl-frame").onclick = () => captureFrame().then(
    () => flash($(".rtdl-frame"), "Сохранено"),
    (e) => flash($(".rtdl-frame"), e.message, true)
  );

  return bar;
}

function readClip() {
  const bar = document.getElementById("rtdl-bar");
  const from = parseTime(bar.querySelector(".rtdl-from").value);
  const to = parseTime(bar.querySelector(".rtdl-to").value);
  if (from == null || to == null || to <= from) return null;
  return { from, to };
}

function updateClipLen() {
  const bar = document.getElementById("rtdl-bar");
  const clip = readClip();
  bar.querySelector(".rtdl-clip-len").textContent = clip ? `${fmtTime(clip.to - clip.from)}` : "неверное время";
  bar.querySelector(".rtdl-clip-len").classList.toggle("rtdl-bad", !clip);
  bar.querySelector(".rtdl-clip-go").disabled = !clip;
}

function flash(btn, text, bad) {
  const span = btn.querySelector("span");
  const old = span.textContent;
  span.textContent = text;
  btn.classList.add(bad ? "rtdl-flash-bad" : "rtdl-flash");
  setTimeout(() => {
    span.textContent = old;
    btn.classList.remove("rtdl-flash", "rtdl-flash-bad");
  }, 1600);
}

function renderMenu() {
  const menu = document.querySelector("#rtdl-bar .rtdl-menu");
  if (!menu) return;
  menu.replaceChildren();
  menu.append(h("div", { className: "rtdl-menu-head" }, "Качество"));
  if (!info || info.error) {
    menu.append(h("div", { className: "rtdl-menu-empty" + (info ? " rtdl-bad" : "") }, info ? info.error : "Загрузка…"));
    return;
  }
  const chosen = pickOption(info.options, pref);
  for (const o of info.options) {
    const item = h("button", { className: "rtdl-menu-item" + (o === chosen ? " rtdl-sel" : "") },
      h("span", { className: "rtdl-check" }, icon("check")),
      h("b", null, o.label),
      h("i", { className: o.hd ? "rtdl-hd" : "" }, o.hd ? o.note || "HD" : o.note),
      h("small", null, fmtSize(o.size)));
    item.onclick = () => {
      pref = o.key === "audio" ? "audio" : String(heightOf(o));
      browser.storage.local.set({ quality: pref });
      menu.hidden = true;
      render();
      download();
    };
    menu.append(item);
  }
}

// ---------- actions ----------

function download(clip) {
  if (!currentId) return;
  const opt = info && info.options && pickOption(info.options, pref);
  browser.runtime.sendMessage({ type: "download", url: location.href, key: opt ? opt.key : pref, clip });
}

async function captureFrame() {
  const v = player();
  if (!v || !v.videoWidth) throw new Error("Нет кадра");
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  let dataUrl;
  try {
    dataUrl = c.toDataURL("image/png");
  } catch {
    throw new Error("Кадр недоступен");
  }
  await browser.runtime.sendMessage({ type: "frame", dataUrl, title: videoTitle(), time: v.currentTime });
}

// Popup asks the page for the player time and to grab frames.
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "playerState") {
    const v = player();
    return Promise.resolve(v ? { time: v.currentTime, duration: v.duration } : null);
  }
  if (msg.type === "captureFrame") return captureFrame().then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
});

// ---------- rendering ----------

function render() {
  const bar = document.getElementById("rtdl-bar");
  if (!bar) return;
  const opt = info && info.options ? pickOption(info.options, pref) : null;
  const q = bar.querySelector(".rtdl-q");
  q.textContent = opt ? `${opt.label}${opt.size ? " · " + fmtSize(opt.size) : ""}` : pref === "audio" ? "M4A" : pref === "max" ? "макс." : `${pref}p`;

  const job = jobs.filter((j) => j.videoId === currentId).sort((a, b) => b.created - a.created)[0];
  const box = bar.querySelector(".rtdl-job");
  box.hidden = !job;
  if (!job) return;
  box.dataset.state = job.status;
  const pct = jobPercent(job);
  const ring = box.querySelector(".rtdl-ring-fill");
  ring.style.strokeDashoffset = String(94.25 * (1 - pct / 100));
  box.classList.toggle("rtdl-indeterminate", job.status === "running" && job.phase !== "download");
  box.querySelector(".rtdl-job-text").textContent = jobStatus(job);
  const act = box.querySelector(".rtdl-job-act");
  if (job.status === "running") {
    act.replaceChildren(icon("close"));
    act.title = "Отменить";
    act.onclick = () => browser.runtime.sendMessage({ type: "cancel", jobId: job.id });
  } else if (job.status === "done") {
    act.replaceChildren(icon("folder"));
    act.title = "Показать в папке";
    act.onclick = () => browser.runtime.sendMessage({ type: "show", jobId: job.id });
  } else {
    act.replaceChildren(icon("close"));
    act.title = "Скрыть";
    act.onclick = () => browser.runtime.sendMessage({ type: "cancel", jobId: job.id });
  }
}

async function loadInfo(id) {
  info = null;
  render();
  const res = await browser.runtime.sendMessage({ type: "info", url: location.href });
  if (id !== currentId) return;
  info = res.ok ? res.info : { error: res.error };
  render();
  const menu = document.querySelector("#rtdl-bar .rtdl-menu");
  if (menu && !menu.hidden) renderMenu();
}

function ensureBar() {
  const id = videoId();
  let bar = document.getElementById("rtdl-bar");
  if (!id) {
    if (bar) bar.remove();
    currentId = null;
    return;
  }
  const anchor = document.querySelector('[class*="pageInfoContainer"]');
  if (!anchor) return;
  if (!bar || bar.nextElementSibling !== anchor) {
    if (bar) bar.remove();
    bar = buildBar();
    anchor.before(bar);
    bar.dataset.theme = isDark() ? "dark" : "light";
    render();
  }
  if (id !== currentId) {
    currentId = id;
    bar.querySelector(".rtdl-clip").hidden = true;
    bar.querySelector(".rtdl-clip-toggle").classList.remove("rtdl-on");
    loadInfo(id);
  }
}

// Rutube has light and dark themes: read the page background.
function isDark() {
  for (const e of [document.body, document.documentElement]) {
    const m = getComputedStyle(e).backgroundColor.match(/\d+(\.\d+)?/g);
    if (m && (m.length < 4 || Number(m[3]) > 0)) return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2] < 128;
  }
  return true;
}

// Rutube is a single-page app: re-check after navigation and DOM re-renders.
setInterval(ensureBar, 1000);
ensureBar();
