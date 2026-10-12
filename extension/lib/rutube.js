// Video info and HLS stream lists from the Rutube player API.
"use strict";

const RT = (() => {
  const cache = new Map(); // key -> { info, time }

  // https://rutube.ru/video/<id>/, /video/private/<id>/?p=<key>, /shorts/<id>/, /play/embed/<id>
  function parseUrl(url) {
    try {
      const u = new URL(url);
      if (!/(^|\.)rutube\.ru$/.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/(?:video(?:\/private)?|shorts|play\/embed)\/([0-9a-f]{32})/);
      return m ? { id: m[1], p: u.searchParams.get("p") || "" } : null;
    } catch {
      return null;
    }
  }

  async function getJson(url) {
    const res = await fetch(url, { credentials: "omit" });
    const data = await res.json().catch(() => null);
    if (!res.ok && !data) throw new Error(`Rutube ответил ${res.status}`);
    return data;
  }

  async function getText(url, signal) {
    const res = await fetch(url, { credentials: "omit", signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  // Master playlist: every quality is listed once per mirror.
  function parseMaster(text) {
    const variants = new Map(); // "WxH@bandwidth" -> variant
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
      const attrs = lines[i].slice(18);
      const url = (lines[i + 1] || "").trim();
      if (!url || url.startsWith("#")) continue;
      const bw = Number((attrs.match(/BANDWIDTH=(\d+)/) || [])[1]) || 0;
      const res = (attrs.match(/RESOLUTION=(\d+)x(\d+)/) || []).slice(1).map(Number);
      const fps = Number((attrs.match(/FRAME-RATE=([\d.]+)/) || [])[1]) || 0;
      const key = `${res.join("x")}@${bw}`;
      if (!variants.has(key)) variants.set(key, { bandwidth: bw, width: res[0] || 0, height: res[1] || 0, fps, mirrors: [] });
      variants.get(key).mirrors.push(url);
    }
    return [...variants.values()];
  }

  // Media playlist: TS segments with their durations.
  function parseMedia(text, base) {
    const segments = [];
    let dur = 0, time = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("#EXT-X-KEY") && !/METHOD=NONE/.test(line)) throw new Error("Видео защищено (DRM)");
      if (line.startsWith("#EXTINF:")) dur = parseFloat(line.slice(8)) || 0;
      else if (line && !line.startsWith("#")) {
        segments.push({ uri: line, url: new URL(line, base).href, start: time, duration: dur });
        time += dur;
      }
    }
    return segments;
  }

  // Audio bitrate per stream, from the balancer URL (guid_..._A192000_...).
  function audioBitrates(balancerUrl) {
    const out = new Map();
    try {
      const guids = new URL(balancerUrl).searchParams.get("guids") || "";
      for (const g of guids.split(",")) {
        const id = g.split("_")[0].replace(/-/g, "");
        const a = g.match(/_B\d+A(\d+)_/);
        if (id && a) out.set(id, Number(a[1]));
      }
    } catch {}
    return out;
  }

  // The API returns either Russian text or codes like "default_does_not_exists_video".
  function apiError(detail) {
    const text = detail && (typeof detail === "string" ? detail : detail.description || detail.title || detail.name || "");
    if (text && /[а-яё]/i.test(text)) return text;
    if (/not_?exist|not_?found|404/i.test(text || "")) return "Видео не найдено";
    if (/private|access|forbidden/i.test(text || "")) return "Видео закрыто автором";
    return "Видео недоступно";
  }

  function label(v) {
    const h = Math.min(v.width, v.height) || v.height;
    return h >= 2160 ? "4K" : h >= 1440 ? "2K" : `${h}p`;
  }

  async function info(url, fresh = false) {
    const ref = parseUrl(url);
    if (!ref) throw new Error("Это не страница видео Rutube");
    const key = ref.id + ref.p;
    const c = cache.get(key);
    if (!fresh && c && Date.now() - c.time < 10 * 60e3) return c.info;

    let api = `https://rutube.ru/api/play/options/${ref.id}/?no_404=true&referer=${encodeURIComponent("https://rutube.ru")}`;
    if (ref.p) api += `&p=${encodeURIComponent(ref.p)}`;
    const d = await getJson(api);
    if (!d || !d.video_balancer || !d.video_balancer.m3u8) throw new Error(apiError(d && d.detail));
    if (d.live_streams && Object.keys(d.live_streams).length && !d.duration) throw new Error("Трансляции не поддерживаются");

    const master = await getText(d.video_balancer.m3u8);
    const variants = parseMaster(master).filter((v) => v.height > 0).sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
    if (!variants.length) throw new Error("Rutube не отдал список качеств");

    const abr = audioBitrates(d.video_balancer.m3u8);
    for (const v of variants) {
      const guid = (v.mirrors[0].match(/\/([0-9a-f]{32})\.mp4\.m3u8/) || [])[1];
      v.audioBitrate = abr.get(guid) || 0;
    }

    // One option per resolution: the highest bitrate one.
    const byHeight = new Map();
    for (const v of variants) if (!byHeight.has(v.height)) byHeight.set(v.height, v);
    const best = [...byHeight.values()];
    const duration = (d.duration || 0) / 1000;

    // Audio only: the smallest stream that carries the best audio.
    const maxAbr = Math.max(...variants.map((v) => v.audioBitrate));
    const audioSrc = variants.filter((v) => v.audioBitrate === maxAbr).sort((a, b) => a.bandwidth - b.bandwidth)[0];

    const i = {
      id: ref.id,
      title: d.title || ref.id,
      author: (d.author && d.author.name) || "",
      duration,
      thumbnail: d.thumbnail_url || "",
      variants: best,
      audioSource: audioSrc,
      options: [
        ...best.map((v) => ({
          key: String(v.height),
          label: label(v),
          note: v.fps > 30 ? `${Math.round(v.fps)} fps` : "",
          size: Math.round((v.bandwidth * duration) / 8),
          hd: v.height >= 720,
        })),
        {
          key: "audio",
          label: "Только звук",
          note: "M4A",
          size: Math.round(((maxAbr || 128000) * duration) / 8),
          hd: false,
        },
      ],
    };
    cache.set(key, { info: i, time: Date.now() });
    return i;
  }

  // Segment list of a variant; tries the mirrors in turn.
  async function segments(variant, signal) {
    let lastError;
    for (const m of variant.mirrors) {
      try {
        return { segments: parseMedia(await getText(m, signal), m), base: m };
      } catch (e) {
        if (signal && signal.aborted) throw e;
        if (/DRM/.test(e.message)) throw e;
        lastError = e;
      }
    }
    throw lastError || new Error("Не удалось получить список сегментов");
  }

  return { parseUrl, info, segments };
})();
