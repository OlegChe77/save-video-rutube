// MPEG-TS demuxer: turns HLS segments (H.264 + AAC) into tracks for mp4.js.
"use strict";

const TS = (() => {
  const PKT = 188;
  const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function readPts(u8, p) {
    // 33-bit timestamp spread over 5 bytes
    return (
      (u8[p] & 0x0e) * 536870912 + // << 29
      u8[p + 1] * 4194304 + // << 22
      ((u8[p + 2] & 0xfe) >> 1) * 32768 + // << 15
      u8[p + 3] * 128 + // << 7
      ((u8[p + 4] & 0xfe) >> 1)
    );
  }

  function concat(parts, total) {
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // Splits an Annex B byte stream into NAL units (without start codes).
  function nalUnits(u8) {
    const out = [];
    let i = 0, start = -1;
    const n = u8.length;
    while (i + 2 < n) {
      if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
        if (start >= 0) {
          let end = i;
          if (end > start && u8[end - 1] === 0) end--; // 4-byte start code
          out.push(u8.subarray(start, end));
        }
        i += 3;
        start = i;
      } else {
        i++;
      }
    }
    if (start >= 0 && start < n) out.push(u8.subarray(start));
    return out;
  }

  // ---------- demuxing ----------

  // segments: array of Uint8Array (whole TS segments in order).
  // Returns raw PES payloads per stream with timestamps and segment index.
  function readPes(segments) {
    let pmtPid = -1, videoPid = -1, audioPid = -1;
    const pes = { video: [], audio: [] };
    const cur = {}; // pid -> { parts, size, pts, dts, frag }

    const flush = (pid) => {
      const c = cur[pid];
      if (!c || !c.size) return;
      const kind = pid === videoPid ? "video" : "audio";
      pes[kind].push({ data: concat(c.parts, c.size), pts: c.pts, dts: c.dts, frag: c.frag });
      cur[pid] = null;
    };

    segments.forEach((u8, segIndex) => {
      for (let p = 0; p + PKT <= u8.length; p += PKT) {
        if (u8[p] !== 0x47) continue;
        const pusi = u8[p + 1] & 0x40;
        const pid = ((u8[p + 1] & 0x1f) << 8) | u8[p + 2];
        const afc = (u8[p + 3] >> 4) & 3;
        let o = p + 4;
        if (afc === 2 || afc === 0) continue; // no payload
        if (afc === 3) o += 1 + u8[o];
        if (o >= p + PKT) continue;

        if (pid === 0) {
          if (pusi) o += 1 + u8[o];
          // PAT: first program's PMT pid
          const secLen = ((u8[o + 1] & 0x0f) << 8) | u8[o + 2];
          for (let q = o + 8; q < o + 3 + secLen - 4; q += 4) {
            const prog = (u8[q] << 8) | u8[q + 1];
            if (prog !== 0) { pmtPid = ((u8[q + 2] & 0x1f) << 8) | u8[q + 3]; break; }
          }
        } else if (pid === pmtPid) {
          if (pusi) o += 1 + u8[o];
          const secLen = ((u8[o + 1] & 0x0f) << 8) | u8[o + 2];
          const end = o + 3 + secLen - 4;
          const progInfo = ((u8[o + 10] & 0x0f) << 8) | u8[o + 11];
          for (let q = o + 12 + progInfo; q < end; ) {
            const type = u8[q];
            const epid = ((u8[q + 1] & 0x1f) << 8) | u8[q + 2];
            const esInfo = ((u8[q + 3] & 0x0f) << 8) | u8[q + 4];
            if (type === 0x1b && videoPid < 0) videoPid = epid; // H.264
            if (type === 0x0f && audioPid < 0) audioPid = epid; // AAC (ADTS)
            q += 5 + esInfo;
          }
        } else if (pid === videoPid || pid === audioPid) {
          if (pusi) {
            flush(pid);
            // PES header
            if (u8[o] !== 0 || u8[o + 1] !== 0 || u8[o + 2] !== 1) continue;
            const flags = u8[o + 7];
            const hdrLen = u8[o + 8];
            let pts = null, dts = null;
            if (flags & 0x80) pts = readPts(u8, o + 9);
            if (flags & 0x40) dts = readPts(u8, o + 14);
            cur[pid] = { parts: [], size: 0, pts, dts: dts == null ? pts : dts, frag: segIndex + 1 };
            o += 9 + hdrLen;
          }
          const c = cur[pid];
          if (!c) continue;
          const chunk = u8.subarray(o, p + PKT);
          c.parts.push(chunk);
          c.size += chunk.length;
        }
      }
      // segments always start with a new PES, so close everything at the boundary
      flush(videoPid);
      flush(audioPid);
    });
    return pes;
  }

  // Undo 33-bit timestamp wrap-around.
  function unwrap(list, key) {
    let offset = 0, prev = null;
    for (const x of list) {
      if (x[key] == null) continue;
      let v = x[key] + offset;
      if (prev != null && v < prev - 4294967296) { offset += 8589934592; v += 8589934592; }
      x[key] = v;
      prev = v;
    }
  }

  // ---------- MP4 sample entries ----------

  function u8s(...bytes) {
    return Uint8Array.from(bytes);
  }

  function u16(v) { return [(v >> 8) & 255, v & 255]; }
  function u32(v) { return [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255]; }
  function str(s) { return [...s].map((c) => c.charCodeAt(0)); }

  function hdlr(type, name) {
    return MP4.full("hdlr", 0, 0, u8s(...u32(0), ...str(type), ...new Array(12).fill(0), ...str(name), 0));
  }

  function dinf() {
    return MP4.box("dinf", MP4.full("dref", 0, 0, Uint8Array.from([...u32(1), ...MP4.full("url ", 0, 1, new Uint8Array(0))])));
  }

  function avc1(sps, pps, width, height) {
    const avcC = MP4.box("avcC", u8s(
      1, sps[1], sps[2], sps[3], 0xff, 0xe1,
      ...u16(sps.length), ...sps,
      1, ...u16(pps.length), ...pps
    ));
    const entry = MP4.box("avc1", u8s(
      0, 0, 0, 0, 0, 0, ...u16(1), // reserved, data_reference_index
      ...new Array(16).fill(0), // pre_defined/reserved
      ...u16(width), ...u16(height),
      ...u32(0x00480000), ...u32(0x00480000), // 72 dpi
      ...u32(0), ...u16(1), // reserved, frame_count
      ...new Array(32).fill(0), // compressor name
      ...u16(0x18), 0xff, 0xff // depth, pre_defined -1
    ), avcC);
    return MP4.full("stsd", 0, 0, Uint8Array.from([...u32(1), ...entry]));
  }

  function descriptor(tag, body) {
    // MPEG-4 descriptor with a fixed 4-byte length field
    const n = body.length;
    return [tag, 0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f, ...body];
  }

  function mp4a(objectType, rateIndex, channels, rate) {
    const asc = [(objectType << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (channels << 3)];
    const decSpecific = descriptor(0x05, asc);
    const decConfig = descriptor(0x04, [0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...decSpecific]);
    const sl = descriptor(0x06, [0x02]);
    const es = descriptor(0x03, [...u16(1), 0, ...decConfig, ...sl]);
    const esds = MP4.full("esds", 0, 0, Uint8Array.from(es));
    const entry = MP4.box("mp4a", u8s(
      0, 0, 0, 0, 0, 0, ...u16(1),
      ...u32(0), ...u32(0), // reserved
      ...u16(channels), ...u16(16), ...u16(0), ...u16(0),
      ...u32(rate * 65536 > 0xffffffff ? 0 : rate * 65536)
    ), esds);
    return MP4.full("stsd", 0, 0, Uint8Array.from([...u32(1), ...entry]));
  }

  // ---------- tracks ----------

  function videoTrack(list, base, startTime, width, height) {
    unwrap(list, "pts");
    unwrap(list, "dts");
    const samples = [];
    const parts = [];
    let total = 0, sps = null, pps = null;
    for (const p of list) {
      const nals = nalUnits(p.data);
      let sync = false, size = 0;
      const keep = [];
      for (const nal of nals) {
        const type = nal[0] & 0x1f;
        if (type === 7) { if (!sps) sps = nal; continue; }
        if (type === 8) { if (!pps) pps = nal; continue; }
        if (type === 9) continue; // access unit delimiter
        if (type === 5) sync = true;
        keep.push(nal);
        size += 4 + nal.length;
      }
      if (!size || p.dts == null) continue;
      const sample = new Uint8Array(size);
      let o = 0;
      for (const nal of keep) {
        sample[o] = nal.length >>> 24; sample[o + 1] = (nal.length >> 16) & 255;
        sample[o + 2] = (nal.length >> 8) & 255; sample[o + 3] = nal.length & 255;
        sample.set(nal, o + 4);
        o += 4 + nal.length;
      }
      parts.push(sample);
      samples.push({ dts: p.dts - base + Math.round(startTime * 90000), cto: p.pts - p.dts, size, sync, offset: total, frag: p.frag });
      total += size;
    }
    if (!samples.length || !sps || !pps) return null;
    for (let i = 0; i < samples.length; i++) {
      const next = samples[i + 1];
      samples[i].dur = next ? Math.max(1, next.dts - samples[i].dts) : samples[i - 1] ? samples[i - 1].dur : 3000;
    }
    // Show the stream from its first frame in presentation order.
    const firstDts = samples[0].dts;
    const minPts = Math.min(...samples.slice(0, 32).map((x) => x.dts + x.cto));
    return {
      kind: "video",
      timescale: 90000,
      language: 0x55c4, // "und"
      width: width * 65536,
      height: height * 65536,
      editMediaTime: Math.max(0, minPts - firstDts),
      hdlr: hdlr("vide", "VideoHandler"),
      mediaHeader: MP4.full("vmhd", 0, 1, new Uint8Array(8)),
      dinf: dinf(),
      stsd: avc1(sps, pps, width, height),
      data: concat(parts, total),
      samples,
    };
  }

  function audioTrack(list, base, startTime) {
    unwrap(list, "pts");
    const samples = [];
    const parts = [];
    let total = 0, cfg = null, next = null;
    for (const p of list) {
      const u8 = p.data;
      let i = 0, frame = 0;
      while (i + 7 <= u8.length) {
        if (u8[i] !== 0xff || (u8[i + 1] & 0xf0) !== 0xf0) { i++; continue; }
        const protAbsent = u8[i + 1] & 1;
        const objectType = ((u8[i + 2] >> 6) & 3) + 1;
        const rateIndex = (u8[i + 2] >> 2) & 0x0f;
        const channels = ((u8[i + 2] & 1) << 2) | (u8[i + 3] >> 6);
        const len = ((u8[i + 3] & 3) << 11) | (u8[i + 4] << 3) | (u8[i + 5] >> 5);
        const head = protAbsent ? 7 : 9;
        if (len < head || i + len > u8.length) break;
        if (!cfg) cfg = { objectType, rateIndex, channels, rate: AAC_RATES[rateIndex] };
        // Timestamps come from the PES; frames inside it follow each other.
        const fromPts = p.pts != null ? Math.round(((p.pts - base) / 90000 + startTime) * cfg.rate) + frame * 1024 : null;
        let dts = next == null ? fromPts : next;
        if (fromPts != null && dts != null && Math.abs(fromPts - dts) > cfg.rate / 2) dts = fromPts; // real gap
        if (dts == null) { i += len; continue; }
        const payload = u8.subarray(i + head, i + len);
        parts.push(payload);
        samples.push({ dts, dur: 1024, cto: 0, size: payload.length, sync: true, offset: total, frag: p.frag });
        total += payload.length;
        next = dts + 1024;
        frame++;
        i += len;
      }
    }
    if (!samples.length) return null;
    return {
      kind: "audio",
      timescale: cfg.rate,
      language: 0x55c4,
      width: 0,
      height: 0,
      editMediaTime: 0,
      hdlr: hdlr("soun", "SoundHandler"),
      mediaHeader: MP4.full("smhd", 0, 0, new Uint8Array(4)),
      dinf: dinf(),
      stsd: mp4a(cfg.objectType, cfg.rateIndex, cfg.channels, cfg.rate),
      data: concat(parts, total),
      samples,
    };
  }

  // segments: TS segments in order; startTime: playlist time (s) of the first one.
  // Sample times are placed on the playlist timeline, so trimming by seconds works.
  function demux(segments, { startTime = 0, width = 0, height = 0 } = {}) {
    const pes = readPes(segments);
    const firsts = [
      pes.video.find((x) => x.dts != null),
      pes.audio.find((x) => x.pts != null),
    ].filter(Boolean);
    if (!firsts.length) throw new Error("В сегментах нет видео");
    const base = Math.min(...firsts.map((x) => (x.dts != null ? x.dts : x.pts)));
    const video = pes.video.length ? videoTrack(pes.video, base, startTime, width, height) : null;
    const audio = pes.audio.length ? audioTrack(pes.audio, base, startTime) : null;
    return { video, audio };
  }

  return { demux };
})();

if (typeof module !== "undefined") module.exports = TS;
