"use strict";

const THREADS = 6;
const SEGMENT_TIMEOUT = 20000;
const jobs = new Map();
const ui = new Set(); // connected popup / content-script ports
let nextJobId = 1;

// ---------- request headers ----------

// Extension requests carry a moz-extension:// Origin; Rutube's CDN expects the site itself.
browser.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    if (d.tabId !== -1) return {};
    const headers = d.requestHeaders.filter((h) => !/^(origin|referer)$/i.test(h.name));
    headers.push({ name: "Referer", value: "https://rutube.ru/" });
    return { requestHeaders: headers };
  },
  { urls: ["*://rutube.ru/*", "*://*.rutube.ru/*", "*://*.rtbcdn.ru/*"] },
  ["blocking", "requestHeaders"]
);

// ---------- state broadcast ----------

const publicJob = (j) => {
  const { controller, ...rest } = j;
  return rest;
};

let broadcastTimer = null;
function broadcast(now = false) {
  if (broadcastTimer && !now) return;
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => (broadcastTimer = null), 250);
  const list = [...jobs.values()].map(publicJob);
  for (const port of ui) port.postMessage({ type: "jobs", jobs: list });
  const running = list.filter((j) => j.status === "running").length;
  browser.browserAction.setBadgeText({ text: running ? String(running) : "" });
}
browser.browserAction.setBadgeBackgroundColor({ color: "#3d5afe" });
browser.browserAction.setBadgeTextColor && browser.browserAction.setBadgeTextColor({ color: "#fff" });

browser.runtime.onConnect.addListener((port) => {
  ui.add(port);
  port.postMessage({ type: "jobs", jobs: [...jobs.values()].map(publicJob) });
  port.onDisconnect.addListener(() => ui.delete(port));
});

// ---------- downloading ----------

function progress(job, n) {
  job.done += n;
  if (job.done > job.total) job.total = job.done; // the size is an estimate until the end
  const now = Date.now();
  const s = job.speedSample;
  if (now - s.time >= 1000) {
    const inst = ((job.done - s.done) * 1000) / (now - s.time);
    job.speed = job.speed ? job.speed * 0.6 + inst * 0.4 : inst;
    job.eta = job.speed > 0 ? Math.round((job.total - job.done) / job.speed) : null;
    job.speedSample = { time: now, done: job.done };
  }
  broadcast();
}

// One segment, with a timeout, retries and fallback to the other mirrors.
async function fetchSegment(job, seg) {
  const urls = [seg.url, ...job.mirrors.filter((m) => m !== job.base).map((m) => new URL(seg.uri, m).href)];
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = urls[attempt % urls.length];
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    job.controller.signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), SEGMENT_TIMEOUT);
    let got = 0;
    try {
      const res = await fetch(url, { credentials: "omit", signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        progress(job, value.length);
      }
      const out = new Uint8Array(got);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    } catch (e) {
      progress(job, -got);
      if (job.controller.signal.aborted) throw e;
      lastError = e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
      job.controller.signal.removeEventListener("abort", onAbort);
    }
  }
  throw lastError && lastError.name === "AbortError" ? new Error("Сервер Rutube не отвечает") : lastError;
}

async function runPool(tasks) {
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) await tasks[i++]();
  };
  await Promise.all(Array.from({ length: Math.min(THREADS, tasks.length) }, worker));
}

function pickVariant(info, key) {
  if (key === "audio") return info.audioSource;
  const limit = key === "max" ? Infinity : Number(key) || 1080;
  return info.variants.find((v) => v.height <= limit) || info.variants[info.variants.length - 1];
}

function label(v) {
  return v.height >= 2160 ? "4K" : v.height >= 1440 ? "2K" : `${v.height}p`;
}

function cleanName(s, fallback) {
  return (s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || fallback;
}

function fmtTime(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
}

function fileName(job) {
  const clip = job.clip ? ` [${fmtTime(job.clip.from)}–${fmtTime(job.clip.to)}]`.replace(/:/g, "-") : "";
  const ext = job.audioOnly ? "m4a" : "mp4";
  return `Rutube/${cleanName(job.title, job.videoId)}${job.audioOnly ? "" : ` (${job.label})`}${clip}.${ext}`;
}

async function startJob({ url, key, clip }) {
  const ref = RT.parseUrl(url);
  if (!ref) return;
  const job = {
    id: nextJobId++,
    videoId: ref.id,
    pageUrl: url,
    title: ref.id,
    thumbnail: "",
    label: "",
    clip: clip || null,
    status: "running",
    phase: "prepare",
    done: 0,
    total: 0,
    speed: 0,
    eta: null,
    speedSample: { time: Date.now(), done: 0 },
    controller: new AbortController(),
    created: Date.now(),
  };
  jobs.set(job.id, job);
  broadcast(true);

  try {
    const info = await RT.info(url);
    const variant = pickVariant(info, key);
    job.title = info.title;
    job.thumbnail = info.thumbnail;
    job.audioOnly = key === "audio";
    job.label = job.audioOnly ? "M4A" : label(variant);
    if (job.clip) job.clip.to = Math.min(job.clip.to, info.duration || job.clip.to);
    broadcast(true);

    const list = await RT.segments(variant, job.controller.signal);
    job.mirrors = variant.mirrors;
    job.base = list.base;
    let segs = list.segments;
    if (job.clip) segs = segs.filter((s) => s.start + s.duration > job.clip.from && s.start < job.clip.to);
    if (!segs.length) throw new Error("Отрывок вне видео");
    job.total = Math.round((segs.reduce((a, s) => a + s.duration, 0) * variant.bandwidth) / 8);

    job.phase = "download";
    job.speedSample = { time: Date.now(), done: 0 };
    broadcast(true);
    const data = new Array(segs.length);
    await runPool(segs.map((s, i) => async () => { data[i] = await fetchSegment(job, s); }));
    job.total = job.done;

    job.phase = "mux";
    broadcast(true);
    await new Promise((r) => setTimeout(r, 0));
    const { video, audio } = TS.demux(data, { startTime: segs[0].start, width: variant.width, height: variant.height });
    data.length = 0;
    const tracks = job.audioOnly ? [audio] : [video, audio];
    if (!tracks[0] || (!job.audioOnly && !audio)) throw new Error("Не удалось разобрать видео");
    if (job.clip) {
      if (video) video.editMediaTime = 0;
      for (const t of tracks) MP4.trim(t, job.clip.from, job.clip.to);
    }
    const blob = new Blob(MP4.build(tracks.filter(Boolean)), { type: job.audioOnly ? "audio/mp4" : "video/mp4" });

    job.phase = "save";
    job.size = blob.size;
    broadcast(true);
    const objectUrl = URL.createObjectURL(blob);
    const { saveAs } = await browser.storage.local.get("saveAs");
    try {
      job.downloadId = await browser.downloads.download({ url: objectUrl, filename: fileName(job), saveAs: !!saveAs, conflictAction: "uniquify" });
    } catch (e) {
      URL.revokeObjectURL(objectUrl);
      if (/cancel/i.test(e.message)) { jobs.delete(job.id); broadcast(true); return; }
      throw e;
    }
    blobUrls.set(job.downloadId, objectUrl);
    job.status = "done";
    job.finished = Date.now();
  } catch (e) {
    if (job.controller.signal.aborted) return;
    console.error(e);
    job.status = "error";
    job.error = e.name === "TypeError" ? "Нет соединения с Rutube" : e.message;
  } finally {
    broadcast(true);
  }
}

const blobUrls = new Map();
browser.downloads.onChanged.addListener((d) => {
  if (d.state && d.state.current !== "in_progress" && blobUrls.has(d.id)) {
    URL.revokeObjectURL(blobUrls.get(d.id));
    blobUrls.delete(d.id);
  }
});

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const id = await browser.downloads.download({ url, filename, conflictAction: "uniquify" });
  blobUrls.set(id, url);
}

async function saveFrame({ dataUrl, title, time }) {
  const blob = await fetch(dataUrl).then((r) => r.blob());
  await saveBlob(blob, `Rutube/${cleanName(title, "frame")} [${fmtTime(time).replace(/:/g, "-")}].png`);
}

async function saveCover({ url, title }) {
  const info = await RT.info(url);
  if (!info.thumbnail) return { ok: false };
  const res = await fetch(info.thumbnail, { credentials: "omit" });
  if (!res.ok) return { ok: false };
  const blob = await res.blob();
  const ext = /png/.test(blob.type) ? "png" : /webp/.test(blob.type) ? "webp" : "jpg";
  await saveBlob(blob, `Rutube/${cleanName(title || info.title, info.id)} (обложка).${ext}`);
  return { ok: true };
}

// ---------- messages ----------

const errorText = (e) => (e.name === "TypeError" ? "Нет соединения с Rutube" : e.message);

browser.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "info":
      return RT.info(msg.url).then(
        (i) => ({ ok: true, info: { ...i, variants: undefined, audioSource: undefined } }),
        (e) => ({ ok: false, error: errorText(e) })
      );
    case "idFromUrl": {
      const ref = RT.parseUrl(msg.url);
      return Promise.resolve(ref ? ref.id : null);
    }
    case "download":
      startJob(msg);
      return Promise.resolve(true);
    case "cancel": {
      const j = jobs.get(msg.jobId);
      if (j) j.controller.abort();
      jobs.delete(msg.jobId);
      broadcast(true);
      return Promise.resolve(true);
    }
    case "show": {
      const j = jobs.get(msg.jobId);
      if (j && j.downloadId != null) return browser.downloads.show(j.downloadId).catch(() => browser.downloads.showDefaultFolder());
      return Promise.resolve(browser.downloads.showDefaultFolder());
    }
    case "clear":
      for (const [id, j] of jobs) if (j.status !== "running") jobs.delete(id);
      broadcast(true);
      return Promise.resolve(true);
    case "frame":
      return saveFrame(msg);
    case "cover":
      return saveCover(msg).catch(() => ({ ok: false }));
  }
});
