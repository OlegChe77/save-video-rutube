// Minimal MP4 writer: builds a regular MP4 file from already encoded
// video/audio samples (see ts.js), without re-encoding.
"use strict";

const MP4 = (() => {
  // ---------- trimming ----------

  // Keeps samples between `from` and `to` seconds. Video has to start on a
  // keyframe, so the frames before `from` are hidden with an edit list.
  function trim(track, from, to) {
    const ts = track.timescale;
    let s = track.samples;
    let startIdx = 0;
    if (track.kind === "video") {
      for (let i = 0; i < s.length; i++) {
        if (s[i].dts / ts > from + 0.001) break;
        if (s[i].sync) startIdx = i;
      }
    } else {
      startIdx = s.findIndex((x) => (x.dts + x.dur) / ts > from);
      if (startIdx < 0) startIdx = s.length;
    }
    let endIdx = s.length;
    if (to != null) {
      const e = s.findIndex((x, i) => i > startIdx && x.dts / ts >= to);
      if (e > 0) endIdx = e;
    }
    track.samples = s.slice(startIdx, endIdx);
    if (track.kind === "video" && track.samples.length) {
      track.editMediaTime = (track.editMediaTime || 0) + Math.max(0, Math.round(from * ts) - track.samples[0].dts);
    }
  }

  // ---------- writing ----------

  function box(type, ...parts) {
    let len = 8;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    new DataView(out.buffer).setUint32(0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function full(type, version, flags, body) {
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, (version << 24) | flags);
    return box(type, head, body);
  }

  function writer(size) {
    const u8 = new Uint8Array(size);
    const dv = new DataView(u8.buffer);
    let p = 0;
    return {
      u8,
      u32: (v) => { dv.setUint32(p, v); p += 4; },
      i32: (v) => { dv.setInt32(p, v); p += 4; },
      u64: (v) => { dv.setBigUint64(p, BigInt(v)); p += 8; },
      i64: (v) => { dv.setBigInt64(p, BigInt(v)); p += 8; },
      u16: (v) => { dv.setUint16(p, v); p += 2; },
      skip: (n) => { p += n; },
    };
  }

  const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

  function mvhd(duration, nextId) {
    const w = writer(108);
    w.u64(0); w.u64(0); // creation/modification time
    w.u32(1000); w.u64(duration);
    w.u32(0x10000); w.u16(0x100); w.skip(10);
    MATRIX.forEach(w.u32);
    w.skip(24);
    w.u32(nextId);
    return full("mvhd", 1, 0, w.u8);
  }

  function tkhd(id, duration, t) {
    const w = writer(92);
    w.u64(0); w.u64(0); w.u32(id); w.u32(0); w.u64(duration);
    w.skip(8); w.u16(0); w.u16(0); w.u16(t.kind === "audio" ? 0x100 : 0); w.skip(2);
    MATRIX.forEach(w.u32);
    w.u32(t.width); w.u32(t.height);
    return full("tkhd", 1, 3, w.u8);
  }

  function mdhd(t, duration) {
    const w = writer(32);
    w.u64(0); w.u64(0); w.u32(t.timescale); w.u64(duration); w.u16(t.language); w.u16(0);
    return full("mdhd", 1, 0, w.u8);
  }

  // entries: [[segmentDuration, mediaTime]], mediaTime -1 = empty edit (delay)
  function elst(entries) {
    const w = writer(4 + entries.length * 20);
    w.u32(entries.length);
    for (const [dur, mt] of entries) { w.u64(dur); w.i64(mt); w.u16(1); w.u16(0); }
    return box("edts", full("elst", 1, 0, w.u8));
  }

  function stbl(t, chunks, chunkOffsets) {
    const s = t.samples;
    // stts: run-length sample durations
    const stts = [];
    for (const x of s) {
      const last = stts[stts.length - 1];
      if (last && last[1] === x.dur) last[0]++;
      else stts.push([1, x.dur]);
    }
    let w = writer(4 + stts.length * 8);
    w.u32(stts.length);
    for (const [n, d] of stts) { w.u32(n); w.u32(d); }
    const parts = [t.stsd, full("stts", 0, 0, w.u8)];

    // ctts: composition offsets (B-frames)
    if (s.some((x) => x.cto !== 0)) {
      const ctts = [];
      for (const x of s) {
        const last = ctts[ctts.length - 1];
        if (last && last[1] === x.cto) last[0]++;
        else ctts.push([1, x.cto]);
      }
      w = writer(4 + ctts.length * 8);
      w.u32(ctts.length);
      for (const [n, c] of ctts) { w.u32(n); w.i32(c); }
      parts.push(full("ctts", ctts.some((c) => c[1] < 0) ? 1 : 0, 0, w.u8));
    }

    // stss: keyframes (omitted when every sample is a keyframe, e.g. audio)
    if (s.some((x) => !x.sync)) {
      const keys = [];
      s.forEach((x, i) => x.sync && keys.push(i + 1));
      w = writer(4 + keys.length * 4);
      w.u32(keys.length);
      keys.forEach(w.u32);
      parts.push(full("stss", 0, 0, w.u8));
    }

    // stsc: samples per chunk
    const stsc = [];
    chunks.forEach((c, i) => {
      const last = stsc[stsc.length - 1];
      if (!last || last[1] !== c.count) stsc.push([i + 1, c.count]);
    });
    w = writer(4 + stsc.length * 12);
    w.u32(stsc.length);
    for (const [first, n] of stsc) { w.u32(first); w.u32(n); w.u32(1); }
    parts.push(full("stsc", 0, 0, w.u8));

    w = writer(8 + s.length * 4);
    w.u32(0); w.u32(s.length);
    for (const x of s) w.u32(x.size);
    parts.push(full("stsz", 0, 0, w.u8));

    w = writer(4 + chunkOffsets.length * 8);
    w.u32(chunkOffsets.length);
    chunkOffsets.forEach(w.u64);
    parts.push(full("co64", 0, 0, w.u8));

    return box("stbl", ...parts);
  }

  function chunksOf(t, index) {
    const out = [];
    let cur = null;
    for (const x of t.samples) {
      if (!cur || cur.frag !== x.frag) {
        cur = { track: index, frag: x.frag, time: x.dts / t.timescale + (t.delay || 0), offset: x.offset, size: 0, count: 0 };
        out.push(cur);
      }
      cur.size += x.size;
      cur.count++;
    }
    return out;
  }

  // Builds a regular MP4. Returns an array of parts suitable for `new Blob(parts)`.
  function build(tracks) {
    tracks = tracks.filter((t) => t.samples.length);
    if (!tracks.length) throw new Error("no samples");

    // Tracks share one timeline: a track that starts later than the others
    // gets an empty edit (delay) so audio and video stay in sync.
    const starts = tracks.map((t) => (t.samples[0].dts + (t.editMediaTime || 0)) / t.timescale);
    const first = Math.min(...starts);
    tracks.forEach((t, i) => (t.delay = starts[i] - first));

    // Rebase each track's media timeline to start at 0.
    for (const t of tracks) {
      const base = t.samples[0].dts;
      if (base) for (const x of t.samples) x.dts -= base;
    }

    const perTrack = tracks.map(chunksOf);
    const order = perTrack.flat().sort((a, b) => a.time - b.time || a.track - b.track);

    const isVideo = tracks.some((t) => t.kind === "video");
    const av1 = tracks.some((t) => String.fromCharCode(...t.stsd.subarray(20, 24)) === "av01");
    const brands = ["isom", "iso2", "mp41", isVideo ? "avc1" : "M4A ", ...(av1 ? ["av01"] : [])];
    const ftypBody = new Uint8Array(8 + brands.length * 4);
    const ftypStr = (isVideo ? "isom" : "M4A ") + "\0\0\x02\0" + brands.join("");
    for (let i = 0; i < ftypStr.length; i++) ftypBody[i] = ftypStr.charCodeAt(i);
    const ftyp = box("ftyp", ftypBody);

    const durations = tracks.map((t) => t.samples.reduce((a, x) => a + x.dur, 0));
    // Presented length: from the edit start to the end of the last frame in display order.
    const shown = tracks.map((t) => {
      let end = 0;
      for (const x of t.samples) end = Math.max(end, x.dts + x.cto + x.dur);
      return Math.round(((end - (t.editMediaTime || 0)) * 1000) / t.timescale);
    });
    const delays = tracks.map((t) => Math.round(t.delay * 1000));
    const movieDur = Math.max(...shown.map((d, i) => d + delays[i]));

    const makeMoov = (offsets) =>
      box(
        "moov",
        mvhd(movieDur, tracks.length + 1),
        ...tracks.map((t, i) => {
          const entries = [];
          if (delays[i] > 0) entries.push([delays[i], -1]);
          if (entries.length || t.editMediaTime) entries.push([shown[i], t.editMediaTime || 0]);
          return box(
            "trak",
            tkhd(i + 1, shown[i] + delays[i], t),
            ...(entries.length ? [elst(entries)] : []),
            box("mdia", mdhd(t, durations[i]), t.hdlr,
              box("minf", t.mediaHeader, t.dinf, stbl(t, perTrack[i], offsets[i])))
          );
        })
      );

    // moov size does not depend on offset values (co64 is fixed width).
    const dummy = tracks.map((_, i) => perTrack[i].map(() => 0));
    const moovSize = makeMoov(dummy).length;
    let pos = ftyp.length + moovSize + 16;
    const offsets = tracks.map(() => []);
    for (const c of order) {
      offsets[c.track].push(pos);
      pos += c.size;
    }
    const mdatSize = pos - ftyp.length - moovSize;
    const mdatHead = new Uint8Array(16);
    const hv = new DataView(mdatHead.buffer);
    hv.setUint32(0, 1);
    mdatHead.set([0x6d, 0x64, 0x61, 0x74], 4);
    hv.setBigUint64(8, BigInt(mdatSize));

    const parts = [ftyp, makeMoov(offsets), mdatHead];
    for (const c of order) parts.push(tracks[c.track].data.subarray(c.offset, c.offset + c.size));
    return parts;
  }

  return { trim, build, box, full };
})();

if (typeof module !== "undefined") module.exports = MP4;
