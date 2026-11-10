#!/usr/bin/env node
// Renders a diagram spec (JSON) to a PNG: boxes placed on a grid the author
// chooses, right-angled lines routed between them, a small arc wherever a
// horizontal line crosses a vertical one. The layout is the author's decision;
// this script only routes, checks and draws.
//
//   node diagram.mjs <spec.json> <out.png> [--svg <out.svg>]
//
// Prints a JSON report (size, crossings, warnings). The spec format is
// documented in ../references/confluence-style.md, section "Diagrams".

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(HERE, "..", "assets", "fonts");
const FONT_REGULAR = join(FONT_DIR, "Inter-Regular.ttf");
const FONT_SEMIBOLD = join(FONT_DIR, "Inter-SemiBold.ttf");
const RESVG_SPEC = "@resvg/resvg-js@^2.6.2";

// ---------------------------------------------------------------- fonts ----

function loadMetrics(file) {
  const b = readFileSync(file);
  const tables = {};
  for (let i = 0, n = b.readUInt16BE(4); i < n; i++) {
    const o = 12 + 16 * i;
    tables[b.toString("latin1", o, o + 4)] = b.readUInt32BE(o + 8);
  }
  const upm = b.readUInt16BE(tables.head + 18);
  const nh = b.readUInt16BE(tables.hhea + 34);
  const adv = (g) => b.readUInt16BE(tables.hmtx + 4 * Math.min(g, nh - 1));
  const cm = tables.cmap;
  let sub = null;
  for (let i = 0, n = b.readUInt16BE(cm + 2); i < n; i++) {
    const p = b.readUInt16BE(cm + 4 + 8 * i), e = b.readUInt16BE(cm + 6 + 8 * i);
    const off = cm + b.readUInt32BE(cm + 8 + 8 * i);
    if (b.readUInt16BE(off) === 4 && ((p === 3 && e === 1) || p === 0)) sub = off;
  }
  const seg = b.readUInt16BE(sub + 6) / 2;
  const endA = sub + 14, startA = endA + 2 * seg + 2, deltaA = startA + 2 * seg, rangeA = deltaA + 2 * seg;
  const glyph = (cp) => {
    for (let i = 0; i < seg; i++) {
      if (b.readUInt16BE(endA + 2 * i) < cp) continue;
      const start = b.readUInt16BE(startA + 2 * i);
      if (start > cp) return 0;
      const delta = b.readInt16BE(deltaA + 2 * i), ro = b.readUInt16BE(rangeA + 2 * i);
      if (ro === 0) return (cp + delta) & 0xffff;
      const g = b.readUInt16BE(rangeA + 2 * i + ro + 2 * (cp - start));
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
  const cache = new Map();
  return (text, size) => {
    let w = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (!cache.has(cp)) cache.set(cp, adv(glyph(cp)));
      w += cache.get(cp);
    }
    return (w * size) / upm;
  };
}

const measure = { regular: loadMetrics(FONT_REGULAR), semibold: loadMetrics(FONT_SEMIBOLD) };

// ------------------------------------------------------------- constants ----

const TONES = {
  blue: { head: "#E3ECF9", border: "#5B7DB1", band: "#F5F8FD", bandline: "#C9D7EE" },
  amber: { head: "#FBEBD9", border: "#B8793A", band: "#FEF9F2", bandline: "#EBCFA8" },
  green: { head: "#E1F2E6", border: "#4F8A5F", band: "#F4FAF6", bandline: "#C4E0CC" },
  purple: { head: "#ECE6F7", border: "#7560A8", band: "#F8F6FC", bandline: "#D6CCEC" },
  gray: { head: "#F1F3F5", border: "#9AA5B1", band: "#F7F8F9", bandline: "#D5DAE0" },
};
const LINE = "#5F6B7A";
const INK = "#111827", SOFT = "#6B7280", LABEL = "#475569";
const HEAD_H = 34, SUB_H = 17, ROW_H = 21, PAD_X = 12, ATTR_PAD = 10;
const SEP = 44;          // min distance between two ports on a top/bottom side
const SEP_V = 26;        // same on a left/right side
const CARD = 24;         // room for a cardinality at a line end
const LANE = 26;         // distance between two lanes in a channel
const COL_GAP = 110, MARGIN = 30, GUTTER = 40;
const BAND_PAD = 10, BAND_GAP = 22;
const HOP = 6;
const LABEL_CHARS = 20;  // the guide's limit for a label, see confluence-style.md

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ------------------------------------------------------------------ spec ----

function readSpec(path) {
  const spec = JSON.parse(readFileSync(path, "utf8"));
  const errors = [];
  const boxes = new Map();
  const bands = new Map((spec.bands || []).map((b) => [b.id, b]));
  for (const b of spec.boxes || []) {
    if (boxes.has(b.id)) errors.push(`duplicate box id ${b.id}`);
    if (!Number.isInteger(b.row) || !Number.isInteger(b.col)) errors.push(`box ${b.id}: row and col must be integers`);
    if (b.band && !bands.has(b.band)) errors.push(`box ${b.id}: unknown band ${b.band}`);
    boxes.set(b.id, { ...b });
  }
  const cells = new Map();
  for (const b of boxes.values()) {
    const k = `${b.row},${b.col}`;
    if (cells.has(k)) errors.push(`boxes ${cells.get(k)} and ${b.id} share cell row ${b.row}, col ${b.col}`);
    cells.set(k, b.id);
  }
  const edges = (spec.edges || []).map((e, i) => {
    if (!boxes.has(e.from)) errors.push(`edge ${i}: unknown box ${e.from}`);
    if (!boxes.has(e.to)) errors.push(`edge ${i}: unknown box ${e.to}`);
    return { i, ...e };
  });
  // bands own whole rows, and each band one continuous block of them
  const rowBand = new Map();
  for (const b of boxes.values()) {
    const key = b.band || "";
    if (rowBand.has(b.row) && rowBand.get(b.row) !== key) errors.push(`row ${b.row} mixes bands ${rowBand.get(b.row) || "(none)"} and ${key || "(none)"}`);
    rowBand.set(b.row, key);
  }
  const maxRow = Math.max(0, ...[...boxes.values()].map((b) => b.row));
  for (let r = 0; r <= maxRow; r++) {
    if (rowBand.has(r)) continue;
    // an empty row goes to the band above it (between two rows of one band: that band)
    let up = r - 1, down = r + 1;
    while (up >= 0 && !rowBand.has(up)) up--;
    while (down <= maxRow && !rowBand.has(down)) down++;
    rowBand.set(r, up >= 0 ? rowBand.get(up) : down <= maxRow ? rowBand.get(down) : "");
  }
  const seen = new Map();
  for (let r = 0; r <= maxRow; r++) {
    const key = rowBand.get(r);
    if (!key) continue;
    if (seen.has(key) && seen.get(key) !== r - 1) errors.push(`band ${key} appears in two places (rows up to ${seen.get(key)} and row ${r}); a band must be one continuous block of rows`);
    seen.set(key, r);
  }
  if (errors.length) {
    console.log(JSON.stringify({ ok: false, errors }, null, 2));
    process.exit(1);
  }
  return { spec, boxes, bands, edges, rowBand };
}

// ----------------------------------------------------------------- boxes ----

function sizeBox(b, tone) {
  b.tone = TONES[b.tone || tone || "blue"] || TONES.blue;
  b.title = b.title || b.id;
  b.subtitle = b.subtitle ? [].concat(b.subtitle) : [];
  b.attrs = b.attrs || [];
  const widths = [measure.semibold(b.title, 15) + 2 * PAD_X];
  for (const s of b.subtitle) widths.push(measure.regular(s, 12) + 2 * PAD_X);
  for (const [n, t] of b.attrs) widths.push(measure.regular(t ? `${n}: ${t}` : n, 13) + 2 * PAD_X);
  b.textW = Math.max(120, ...widths);
  b.headH = HEAD_H + b.subtitle.length * SUB_H;
  b.h = b.headH + (b.attrs.length ? b.attrs.length * ROW_H + ATTR_PAD : 0);
  if (b.shape === "store") b.h += 12;
  b.h0 = b.h;
}

// --------------------------------------------------------------- routing ----

// A route is a topology on the grid; geometry is derived from it later.
//   SH / SV  straight between facing sides
//   LA       leave a sideways, enter b from above/below
//   LB       leave a upwards/downwards, enter b sideways
//   ZV       vertical exit, run in horizontal channel k, vertical entry
//   ZH       sideways exit, run in vertical channel j, sideways entry
//   W        vertical exit, channel k1, vertical channel j, channel k2, vertical entry
//   SELF     loop out of one side and back, at the start or end of that side,
//            through the channel next to it

function candidates(e, B, occ, R, C) {
  const a = B.get(e.from), b = B.get(e.to);
  const ra = a.row, ca = a.col, rb = b.row, cb = b.col;
  const has = (r, c) => occ.has(`${r},${c}`);
  const colFree = (c, r1, r2) => { for (let r = Math.min(r1, r2) + 1; r < Math.max(r1, r2); r++) if (has(r, c)) return false; return true; };
  const rowFree = (r, c1, c2) => { for (let c = Math.min(c1, c2) + 1; c < Math.max(c1, c2); c++) if (has(r, c)) return false; return true; };
  const out = [];
  if (a === b) {
    const loops = [];
    for (const side of ["R", "B", "T", "L"])
      for (const end of ["hi", "lo"])
        loops.push({ t: "SELF", side, end, sa: side, sb: side, j: side === "R" ? ca + 1 : ca, k: side === "B" ? ra + 1 : ra, cost: 0 });
    return loops;
  }
  if (ra === rb && rowFree(ra, ca, cb)) out.push({ t: "SH", sa: cb > ca ? "R" : "L", sb: cb > ca ? "L" : "R", cost: Math.abs(cb - ca) });
  if (ca === cb && colFree(ca, ra, rb)) out.push({ t: "SV", sa: rb > ra ? "B" : "T", sb: rb > ra ? "T" : "B", cost: Math.abs(rb - ra) });
  const g = Math.abs(ra - rb) + Math.abs(ca - cb);
  if (ca !== cb && ra !== rb) {
    if (rowFree(ra, ca, cb) && !has(ra, cb) && colFree(cb, ra, rb))
      out.push({ t: "LA", sa: cb > ca ? "R" : "L", sb: rb > ra ? "T" : "B", cost: 8 + g });
    if (colFree(ca, ra, rb) && !has(rb, ca) && rowFree(rb, ca, cb))
      out.push({ t: "LB", sa: rb > ra ? "B" : "T", sb: cb > ca ? "L" : "R", cost: 8 + g });
  }
  // vertical exit and entry through horizontal channel k (channel k lies above row k)
  const exitOK = (side, k) => side === "B" ? k >= ra + 1 && colFree(ca, ra, k) : k <= ra && colFree(ca, k - 1, ra);
  const entryOK = (side, k) => side === "T" ? k <= rb && colFree(cb, k - 1, rb) : k >= rb + 1 && colFree(cb, rb, k);
  for (let k = 0; k <= R; k++)
    for (const sa of ["T", "B"])
      for (const sb of ["T", "B"])
        if (exitOK(sa, k) && entryOK(sb, k)) {
          const detour = Math.max(0, Math.min(ra, rb) + 1 - k, k - Math.max(ra, rb));
          out.push({ t: "ZV", sa, sb, k, cost: 16 + g + 3 * detour });
        }
  // sideways exit and entry through vertical channel j (channel j lies left of column j)
  const sExitOK = (side, j) => side === "R" ? j >= ca + 1 && rowFree(ra, ca, j) : j <= ca && rowFree(ra, j - 1, ca);
  const sEntryOK = (side, j) => side === "L" ? j <= cb && rowFree(rb, j - 1, cb) : j >= cb + 1 && rowFree(rb, cb, j);
  for (let j = 0; j <= C; j++)
    for (const sa of ["L", "R"])
      for (const sb of ["L", "R"])
        if (sExitOK(sa, j) && sEntryOK(sb, j)) {
          const detour = Math.max(0, Math.min(ca, cb) + 1 - j, j - Math.max(ca, cb));
          out.push({ t: "ZH", sa, sb, j, cost: 18 + g + 3 * detour });
        }
  // fallback: around everything
  for (const sa of ["T", "B"])
    for (const sb of ["T", "B"]) {
      const k1 = sa === "B" ? ra + 1 : ra, k2 = sb === "T" ? rb : rb + 1;
      if (!exitOK(sa, k1) || !entryOK(sb, k2) || k1 === k2) continue;
      for (let j = 0; j <= C; j++) out.push({ t: "W", sa, sb, k1, k2, j, cost: 40 + g + Math.abs(j - (ca + cb + 1) / 2) });
    }
  return out;
}

// --------------------------------------------------------------- geometry ----

function layout(model, routes) {
  const { boxes: B, edges, rowBand } = model;
  const R = model.R, C = model.C;
  // 1. endpoints per box side
  const sides = new Map(); // `${id}:${side}` -> [{e, end, key, fixed}]
  const addEnd = (id, side, item) => {
    const k = `${id}:${side}`;
    if (!sides.has(k)) sides.set(k, []);
    sides.get(k).push(item);
  };
  const lanesH = Array.from({ length: R + 1 }, () => []);
  const lanesV = Array.from({ length: C + 1 }, () => []);
  for (const e of edges) {
    const r = routes[e.i], a = B.get(e.from), b = B.get(e.to);
    if (r.t === "SELF") {
      // both ends side by side at one end of the side, so no other line lands between them
      const base = r.end === "hi" ? 1000 : -1001;
      addEnd(a.id, r.side, { e, end: "a", key: base });
      addEnd(a.id, r.side, { e, end: "b", key: base + 1 });
      if (r.side === "L" || r.side === "R") lanesV[r.j].push({ e, seg: "self" });
      else lanesH[r.k].push({ e, seg: "self" });
      continue;
    }
    let ka, kb;
    const cxOf = (x) => x.col, ryOf = (x) => x.row;
    switch (r.t) {
      case "SH": case "SV": ka = kb = 0; break;
      case "LA": ka = ryOf(b) - ryOf(a); kb = cxOf(a) - cxOf(b); break;
      case "LB": ka = cxOf(b) - cxOf(a); kb = ryOf(a) - ryOf(b); break;
      case "ZV": ka = cxOf(b) - cxOf(a); kb = cxOf(a) - cxOf(b); lanesH[r.k].push({ e, seg: "main" }); break;
      case "ZH": ka = ryOf(b) - ryOf(a); kb = ryOf(a) - ryOf(b); lanesV[r.j].push({ e, seg: "main" }); break;
      case "W": ka = r.j - 0.5 - cxOf(a); kb = r.j - 0.5 - cxOf(b); lanesH[r.k1].push({ e, seg: "k1" }); lanesH[r.k2].push({ e, seg: "k2" }); lanesV[r.j].push({ e, seg: "j" }); break;
    }
    addEnd(a.id, r.sa, { e, end: "a", key: ka, straight: r.t === "SH" || r.t === "SV" });
    addEnd(b.id, r.sb, { e, end: "b", key: kb, straight: r.t === "SH" || r.t === "SV" });
  }
  // 2. box sizes: the text, and enough room for the ports on each side
  for (const b of B.values()) {
    const n = Math.max((sides.get(`${b.id}:T`) || []).length, (sides.get(`${b.id}:B`) || []).length);
    b.w = Math.max(b.textW, (n + 1) * SEP);
    const m = Math.max((sides.get(`${b.id}:L`) || []).length, (sides.get(`${b.id}:R`) || []).length);
    b.h = Math.max(b.h0, m > 1 ? (m + 1) * SEP_V + 20 : 0);
  }
  // 3. columns and channels
  const colW = Array(C).fill(0), rowH = Array(R).fill(0);
  for (const b of B.values()) { colW[b.col] = Math.max(colW[b.col], b.w); rowH[b.row] = Math.max(rowH[b.row], b.h); }
  const bandsOn = model.bands.size > 0;
  // a straight line between neighbouring columns carries its label and both
  // cardinalities in the gap, so the gap grows until they fit side by side
  const labelNeed = Array(C + 1).fill(0), labelBy = [];
  for (const e of edges) {
    const r = routes[e.i], a = B.get(e.from), b = B.get(e.to);
    if (r.t !== "SH" || Math.abs(a.col - b.col) !== 1 || !e.label) continue;
    const cardW = (t) => (t && e.kind !== "inheritance" ? measure.regular(t, 12) + 12 : 8);
    const j = Math.max(a.col, b.col);
    const need = measure.regular(e.label, 12) + 10 + cardW(e.fromCard) + cardW(e.toCard) + 24;
    if (need > labelNeed[j]) { labelNeed[j] = need; labelBy[j] = e; }
  }
  const vGap = (j) => {
    const n = lanesV[j].length;
    if (j === 0 || j === C) return n ? 30 + n * LANE : 0;
    return Math.max(COL_GAP, 2 * 40 + n * LANE, labelNeed[j]);
  };
  const colX = []; // left edge of each column
  let x = MARGIN + (bandsOn ? GUTTER : 0) + 10;
  const vStart = [];
  for (let j = 0; j <= C; j++) {
    vStart[j] = x;
    x += vGap(j);
    if (j < C) { colX[j] = x; x += colW[j]; }
  }
  const width = x + 20 + MARGIN + (lanesV[C].some((it) => it.e.label) ? 110 : 0);
  // horizontal channels: structure depends on whether a band boundary lies in it
  const bandOfRow = (r) => (r < 0 || r >= R ? null : rowBand.get(r) || null);
  const hPlan = [];
  let y = MARGIN;
  const rowY = [];
  const bandEdges = []; // [{band, top, bottom}]
  let curTop = null;
  for (let k = 0; k <= R; k++) {
    const above = bandOfRow(k - 1), below = bandOfRow(k);
    const n = lanesH[k].length;
    const boundary = above !== below;
    const laneBlock = n ? (n + 0.5) * LANE : k === 0 || k === R ? 0 : LANE;
    const plan = {};
    if (k > 0) y += CARD; // cards under the row above
    const lanes = () => { plan.laneTop = y; y += laneBlock; };
    const close = () => { y += BAND_PAD; bandEdges.push({ band: above, top: curTop, bottom: y }); };
    const open = () => { curTop = y; y += BAND_PAD + 4; };
    // lanes live in the band below the channel, else in the band above
    if (!boundary) lanes();
    else if (above && below) { close(); y += BAND_GAP; open(); lanes(); }
    else if (above) { lanes(); close(); }
    else { if (k > 0) lanes(); open(); if (k === 0) lanes(); }
    if (k < R) { y += CARD; rowY[k] = y; y += rowH[k]; }
    hPlan[k] = plan;
  }
  const height = y + MARGIN;
  // 4. box positions: centred in their column, top-aligned in their row
  for (const b of B.values()) { b.x = colX[b.col] + (colW[b.col] - b.w) / 2; b.y = rowY[b.row]; }
  // 5. ports
  const port = new Map(); // `${e.i}:${end}` -> {x,y,side}
  const straightPos = new Map();
  for (const e of edges) {
    const r = routes[e.i];
    if (r.t !== "SH" && r.t !== "SV") continue;
    const a = B.get(e.from), b = B.get(e.to);
    if (r.t === "SV") {
      const lo = Math.max(a.x, b.x) + 18, hi = Math.min(a.x + a.w, b.x + b.w) - 18;
      straightPos.set(e.i, { lo, hi });
    } else {
      const lo = Math.max(a.y + 12, b.y + 12), hi = Math.min(a.y + a.h, b.y + b.h) - 10;
      straightPos.set(e.i, { lo, hi });
    }
  }
  // straight lines get their coordinate first, in the range both boxes share,
  // kept SEP apart from other straight lines on the same sides
  const fixedOn = new Map(); // `${id}:${side}` -> [coords]
  for (const e of edges) {
    const r = routes[e.i];
    if (r.t !== "SH" && r.t !== "SV") continue;
    const s = straightPos.get(e.i), gap = r.t === "SV" ? SEP : SEP_V;
    const ka = `${e.from}:${r.sa}`, kb = `${e.to}:${r.sb}`;
    const taken = [...(fixedOn.get(ka) || []), ...(fixedOn.get(kb) || [])];
    const ideal = (k, id) => {
      const list = [...sides.get(k)].sort((p, q) => p.key - q.key || p.e.i - q.e.i);
      const b = B.get(id), n = list.length, idx = list.findIndex((it) => it.e === e);
      const vertical = k.endsWith(":T") || k.endsWith(":B");
      const lo = vertical ? b.x + 16 : b.y + 12, hi = vertical ? b.x + b.w - 16 : b.y + b.h - 8;
      return lo + ((idx + 1) * (hi - lo)) / (n + 1);
    };
    const mid = Math.min(Math.max((ideal(ka, e.from) + ideal(kb, e.to)) / 2, s.lo), s.hi);
    let v = mid;
    for (let step = 0; step < 12; step++) {
      const c = mid + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * gap;
      if (c < s.lo || c > s.hi) continue;
      if (taken.every((t) => Math.abs(t - c) >= gap)) { v = c; break; }
    }
    s.fixed = Math.round(v);
    for (const k of [ka, kb]) { if (!fixedOn.has(k)) fixedOn.set(k, []); fixedOn.get(k).push(s.fixed); }
  }
  for (const [k, items] of sides) {
    const [id, side] = k.split(":");
    const b = B.get(id);
    const vertical = side === "T" || side === "B";
    const lo = vertical ? b.x + 16 : b.y + 12;
    const hi = vertical ? b.x + b.w - 16 : b.y + b.h - 8;
    items.sort((p, q) => p.key - q.key || p.e.i - q.e.i);
    // fixed (straight) ports keep their coordinate, and stay in sorted order by it
    const fixed = items.filter((it) => it.straight).sort((p, q) => straightPos.get(p.e.i).fixed - straightPos.get(q.e.i).fixed);
    let fi = 0;
    const ordered = items.map((it) => (it.straight ? fixed[fi++] : it));
    const pos = ordered.map((it) => (it.straight ? straightPos.get(it.e.i).fixed : null));
    // floating ports share the gaps between fixed ones evenly
    for (let i = 0; i < ordered.length; ) {
      if (pos[i] !== null) { i++; continue; }
      let j = i;
      while (j < ordered.length && pos[j] === null) j++;
      const L = i > 0 ? pos[i - 1] : lo, Rv = j < ordered.length ? pos[j] : hi, m = j - i;
      for (let t = 0; t < m; t++) pos[i + t] = L + ((t + 1) * (Rv - L)) / (m + 1);
      i = j;
    }
    ordered.forEach((it, i) => {
      const v = Math.round(pos[i]);
      const p = vertical ? { x: v, y: side === "T" ? b.y : b.y + b.h } : { x: side === "L" ? b.x : b.x + b.w, y: v };
      port.set(`${it.e.i}:${it.end}`, { ...p, side });
    });
  }
  // 6. lanes: order them so connectors cross as little as possible
  const laneY = new Map(), laneX = new Map();
  // +1: the end connects to the row above the channel, -1: to the row below
  const up = (side) => (side === "B" ? 1 : -1);
  const endsH = (it) => {
    const r = routes[it.e.i], pa = port.get(`${it.e.i}:a`), pb = port.get(`${it.e.i}:b`);
    if (r.t === "ZV") return [[pa.x, up(r.sa)], [pb.x, up(r.sb)]];
    if (r.t === "SELF") return [[pa.x, up(r.side)], [pb.x, up(r.side)]];
    const vx = vStart[r.j] + vGap(r.j) / 2;
    if (it.seg === "k1") return [[pa.x, up(r.sa)], [vx, r.k2 > r.k1 ? -1 : 1]];
    return [[pb.x, up(r.sb)], [vx, r.k1 > r.k2 ? -1 : 1]];
  };
  for (let k = 0; k <= R; k++) {
    const items = lanesH[k].map((it) => {
      const ends = endsH(it);
      const [x1, x2] = [Math.min(ends[0][0], ends[1][0]), Math.max(ends[0][0], ends[1][0])];
      const ups = ends.filter(([, d]) => d > 0).length;
      return { it, x1, x2, ups };
    });
    items.sort((p, q) => q.ups - p.ups || (p.ups === 2 ? (p.x2 - p.x1) - (q.x2 - q.x1) : (q.x2 - q.x1) - (p.x2 - p.x1)) || p.it.e.i - q.it.e.i);
    const top = hPlan[k].laneTop;
    items.forEach((m, i) => laneY.set(`${m.it.e.i}:${m.it.seg}`, Math.round(top + (i + 0.75) * LANE)));
  }
  for (let j = 0; j <= C; j++) {
    const items = lanesV[j].map((it) => {
      const r = routes[it.e.i];
      let ys, lefts = 0;
      if (it.seg === "self") {
        ys = [port.get(`${it.e.i}:a`).y, port.get(`${it.e.i}:b`).y];
        lefts = r.side === "R" ? 2 : 0;
      }
      else if (r.t === "ZH") {
        const pa = port.get(`${it.e.i}:a`), pb = port.get(`${it.e.i}:b`);
        ys = [pa.y, pb.y];
        lefts = (r.sa === "R" ? 1 : 0) + (r.sb === "R" ? 1 : 0);
      } else {
        ys = [laneY.get(`${it.e.i}:k1`), laneY.get(`${it.e.i}:k2`)];
        lefts = (B.get(it.e.from).col < j ? 1 : 0) + (B.get(it.e.to).col < j ? 1 : 0);
      }
      return { it, y1: Math.min(...ys), y2: Math.max(...ys), lefts };
    });
    items.sort((p, q) => q.lefts - p.lefts || (p.lefts === 2 ? (p.y2 - p.y1) - (q.y2 - q.y1) : (q.y2 - q.y1) - (p.y2 - p.y1)) || p.it.e.i - q.it.e.i);
    const left = vStart[j] + (j === 0 ? 10 : 34);
    items.forEach((m, i) => laneX.set(`${m.it.e.i}:${m.it.seg}`, Math.round(left + (i + 0.5) * LANE)));
  }
  // 7. polylines
  for (const e of edges) {
    const r = routes[e.i];
    const pa = port.get(`${e.i}:a`), pb = port.get(`${e.i}:b`);
    let pts;
    switch (r.t) {
      case "SELF": {
        if (r.side === "L" || r.side === "R") {
          const lx = laneX.get(`${e.i}:self`);
          pts = [[pa.x, pa.y], [lx, pa.y], [lx, pb.y], [pb.x, pb.y]];
        } else {
          const ly = laneY.get(`${e.i}:self`);
          pts = [[pa.x, pa.y], [pa.x, ly], [pb.x, ly], [pb.x, pb.y]];
        }
        break;
      }
      case "SH": case "SV": pts = [[pa.x, pa.y], [pb.x, pb.y]]; break;
      case "LA": pts = [[pa.x, pa.y], [pb.x, pa.y], [pb.x, pb.y]]; break;
      case "LB": pts = [[pa.x, pa.y], [pa.x, pb.y], [pb.x, pb.y]]; break;
      case "ZV": { const ly = laneY.get(`${e.i}:main`); pts = [[pa.x, pa.y], [pa.x, ly], [pb.x, ly], [pb.x, pb.y]]; break; }
      case "ZH": { const lx = laneX.get(`${e.i}:main`); pts = [[pa.x, pa.y], [lx, pa.y], [lx, pb.y], [pb.x, pb.y]]; break; }
      case "W": {
        const y1 = laneY.get(`${e.i}:k1`), y2 = laneY.get(`${e.i}:k2`), lx = laneX.get(`${e.i}:j`);
        pts = [[pa.x, pa.y], [pa.x, y1], [lx, y1], [lx, y2], [pb.x, y2], [pb.x, pb.y]];
        break;
      }
    }
    e.pts = simplify(pts);
    e.pa = pa; e.pb = pb;
  }
  // bands span the full width
  const bandRects = bandEdges.map((be) => ({ ...be, x: MARGIN, w: width - 2 * MARGIN }));
  // how many line ends meet each box side, and which labels pushed their
  // columns apart - both for the hints in the report
  const sideCounts = new Map([...sides].map(([k, items]) => [k, items.length]));
  const widened = [];
  for (let j = 1; j < C; j++)
    // the guide's rule is "about 20 characters", so that is what the hint
    // checks - and only where the label actually pushed its columns apart
    if (labelBy[j] && [...labelBy[j].label].length > LABEL_CHARS && labelNeed[j] > Math.max(COL_GAP, 2 * 40 + lanesV[j].length * LANE))
      widened.push(`label "${labelBy[j].label}" has ${[...labelBy[j].label].length} characters and widens the gap between ${labelBy[j].from} and ${labelBy[j].to} to ${Math.round(vGap(j))} px; keep it to about ${LABEL_CHARS}`);
  return { width, height, bandRects, sideCounts, widened };
}

function simplify(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = out[out.length - 1];
    if (p[0] === q[0] && p[1] === q[1]) continue;
    if (out.length >= 2) {
      const o = out[out.length - 2];
      if ((o[0] === q[0] && q[0] === p[0]) || (o[1] === q[1] && q[1] === p[1])) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

// ------------------------------------------------------------- checking ----

function segs(e) { const s = []; for (let i = 1; i < e.pts.length; i++) s.push([e.pts[i - 1], e.pts[i], i - 1]); return s; }

// where a cardinality's text sits; cardSvg draws it at the same place
function cardRect(p, side, text) {
  const w = measure.regular(text, 12), h = 13;
  if (side === "T") return { x: p.x + 5, y: p.y - 17, w, h, tx: p.x + 5, ty: p.y - 7, anchor: "start" };
  if (side === "B") return { x: p.x + 5, y: p.y + 6, w, h, tx: p.x + 5, ty: p.y + 16, anchor: "start" };
  if (side === "L") return { x: p.x - 6 - w, y: p.y - 16, w, h, tx: p.x - 6, ty: p.y - 6, anchor: "end" };
  return { x: p.x + 6, y: p.y - 16, w, h, tx: p.x + 6, ty: p.y - 6, anchor: "start" };
}

function cards(model) {
  const out = [];
  for (const e of model.edges) {
    if (e.kind === "inheritance") continue;
    if (e.fromCard) out.push({ e, text: e.fromCard, ...cardRect(e.pa, e.pa.side, e.fromCard) });
    if (e.toCard) out.push({ e, text: e.toCard, ...cardRect(e.pb, e.pb.side, e.toCard) });
  }
  return out;
}

const overlap = (r, a, pad = 0) => r.x < a.x + a.w + pad && r.x + r.w + pad > a.x && r.y < a.y + a.h + pad && r.y + r.h + pad > a.y;

function analyse(model) {
  const { edges, boxes } = model;
  const hops = new Map();
  let crossings = 0;
  const warnings = [];
  const all = edges.map((e) => segs(e));
  for (const e of edges) for (const [p, q, si] of all[e.i]) {
    if (p[1] !== q[1]) continue;
    const y = p[1], x1 = Math.min(p[0], q[0]), x2 = Math.max(p[0], q[0]);
    for (const f of edges) {
      if (f === e) continue;
      for (const [r, s] of all[f.i]) {
        if (r[0] !== s[0]) continue;
        const x = r[0], y1 = Math.min(r[1], s[1]), y2 = Math.max(r[1], s[1]);
        if (x1 + 2 < x && x < x2 - 2 && y1 + 2 < y && y < y2 - 2) {
          const k = `${e.i}:${si}`;
          if (!hops.has(k)) hops.set(k, []);
          hops.get(k).push(x);
          crossings++;
        }
      }
    }
  }
  let bad = 0;
  for (const e of edges) for (const [p, q] of all[e.i]) {
    const x1 = Math.min(p[0], q[0]), x2 = Math.max(p[0], q[0]), y1 = Math.min(p[1], q[1]), y2 = Math.max(p[1], q[1]);
    for (const b of boxes.values()) {
      if (x1 < b.x + b.w - 1 && x2 > b.x + 1 && y1 < b.y + b.h - 1 && y2 > b.y + 1) {
        warnings.push(`line ${e.from} - ${e.to} runs through box ${b.id}`);
        bad++;
      }
    }
  }
  const flat = edges.flatMap((e) => all[e.i].map(([p, q]) => ({ e, p, q })));
  for (let i = 0; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) {
    const A = flat[i], Bs = flat[j];
    if (A.e === Bs.e) continue;
    const hor = A.p[1] === A.q[1] && Bs.p[1] === Bs.q[1] && Math.abs(A.p[1] - Bs.p[1]) < 6;
    const ver = A.p[0] === A.q[0] && Bs.p[0] === Bs.q[0] && Math.abs(A.p[0] - Bs.p[0]) < 6;
    if (!hor && !ver) continue;
    const ax = hor ? [A.p[0], A.q[0]] : [A.p[1], A.q[1]], bx = hor ? [Bs.p[0], Bs.q[0]] : [Bs.p[1], Bs.q[1]];
    const ov = Math.min(Math.max(...ax), Math.max(...bx)) - Math.max(Math.min(...ax), Math.min(...bx));
    if (ov > 2) { warnings.push(`lines ${A.e.from} - ${A.e.to} and ${Bs.e.from} - ${Bs.e.to} run on top of each other`); bad++; }
  }
  // cardinalities must stay readable: not on each other, not on a box
  let clash = 0;
  const cs = cards(model);
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++)
      if (overlap(cs[i], cs[j], 2)) { warnings.push(`cardinalities ${cs[i].text} (${cs[i].e.from} - ${cs[i].e.to}) and ${cs[j].text} (${cs[j].e.from} - ${cs[j].e.to}) overlap`); clash++; }
    for (const b of boxes.values())
      if (overlap(cs[i], { x: b.x, y: b.y, w: b.w, h: b.h })) { warnings.push(`cardinality ${cs[i].text} (${cs[i].e.from} - ${cs[i].e.to}) sits on box ${b.id}`); clash++; }
  }
  return { hops, crossings, warnings: [...new Set(warnings)], bad, clash };
}

// -------------------------------------------------------------- optimise ----

function solve(model) {
  const { boxes: B, edges } = model;
  const occ = new Map([...B.values()].map((b) => [`${b.row},${b.col}`, b.id]));
  const cands = edges.map((e) => candidates(e, B, occ, model.R, model.C).sort((p, q) => p.cost - q.cost));
  for (const e of edges) if (!cands[e.i].length) { console.log(JSON.stringify({ ok: false, errors: [`no route for ${e.from} - ${e.to}`] })); process.exit(1); }
  const pick = cands.map(() => 0);
  const score = () => {
    const routes = pick.map((p, i) => cands[i][p]);
    const geo = layout(model, routes);
    const a = analyse(model);
    const labelCost = placeLabels(model, geo).cost;
    // a crossing is drawn as a small arc and reads fine; a detour around the
    // whole picture does not. So length and bends weigh about as much.
    let shape = 0;
    for (const e of edges) {
      for (let i = 1; i < e.pts.length; i++) shape += (Math.abs(e.pts[i][0] - e.pts[i - 1][0]) + Math.abs(e.pts[i][1] - e.pts[i - 1][1])) / 15;
      shape += (e.pts.length - 2) * 8;
    }
    // a box grown for its ports costs a little, so a free side wins
    for (const b of B.values()) shape += (b.h - b.h0) / 3;
    return { total: a.bad * 1000 + a.clash * 150 + labelCost * 6 + a.crossings * 12 + shape + routes.reduce((s, r) => s + r.cost, 0), a };
  };
  let best = score().total;
  for (let pass = 0; pass < 4; pass++) {
    let improved = false;
    for (const e of edges) {
      const keep = pick[e.i];
      let bestK = keep;
      for (let k = 0; k < Math.min(cands[e.i].length, 60); k++) {
        if (k === keep) continue;
        pick[e.i] = k;
        const s = score().total;
        if (s < best) { best = s; bestK = k; improved = true; }
      }
      pick[e.i] = bestK;
    }
    if (!improved) break;
  }
  const routes = pick.map((p, i) => cands[i][p]);
  const geo = layout(model, routes);
  // a detour where a straight line was possible is worth a look, whatever caused it
  const detours = edges.filter((e) => !["SH", "SV", "SELF"].includes(routes[e.i].t) && cands[e.i].some((c) => c.t === "SH" || c.t === "SV"))
    .map((e) => `line ${e.from} - ${e.to} takes a detour where a straight line was possible`);
  return { routes, geo, detours, ...analyse(model) };
}

// ---------------------------------------------------------------- render ----

function boxSvg(b) {
  const t = b.tone, o = [];
  const dash = b.shape === "external" ? ' stroke-dasharray="5 4"' : "";
  if (b.shape === "store") {
    const rx = b.w / 2, ry = 7, top = b.y + ry, bot = b.y + b.h - ry;
    o.push(`<path d="M${b.x},${top} A${rx},${ry} 0 0 1 ${b.x + b.w},${top} V${bot} A${rx},${ry} 0 0 1 ${b.x},${bot} Z" fill="#FFFFFF" stroke="${t.border}" stroke-width="1.2"/>`);
    o.push(`<path d="M${b.x},${top} A${rx},${ry} 0 0 0 ${b.x + b.w},${top} A${rx},${ry} 0 0 0 ${b.x},${top} Z" fill="${t.head}" stroke="${t.border}" stroke-width="1.2"/>`);
    const cy = b.y + 14;
    o.push(`<text x="${b.x + b.w / 2}" y="${cy + 22}" text-anchor="middle" font-family="Inter SemiBold" font-size="15" fill="${INK}">${esc(b.title)}</text>`);
    b.subtitle.forEach((s, i) => o.push(`<text x="${b.x + b.w / 2}" y="${cy + 22 + (i + 1) * SUB_H}" text-anchor="middle" font-family="Inter" font-size="12" fill="${SOFT}">${esc(s)}</text>`));
    return o.join("\n");
  }
  o.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3" fill="#FFFFFF"/>`);
  o.push(`<path d="M${b.x + 3},${b.y} h${b.w - 6} a3,3 0 0 1 3,3 v${b.headH - 3} h${-b.w} v${-(b.headH - 3)} a3,3 0 0 1 3,-3 z" fill="${t.head}"/>`);
  o.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3" fill="none" stroke="${t.border}" stroke-width="1.2"${dash}/>`);
  o.push(`<text x="${b.x + b.w / 2}" y="${b.y + 22}" text-anchor="middle" font-family="Inter SemiBold" font-size="15" fill="${INK}">${esc(b.title)}</text>`);
  b.subtitle.forEach((s, i) => o.push(`<text x="${b.x + b.w / 2}" y="${b.y + 22 + (i + 1) * SUB_H}" text-anchor="middle" font-family="Inter" font-size="12" fill="${SOFT}">${esc(s)}</text>`));
  if (b.attrs.length) {
    o.push(`<line x1="${b.x}" y1="${b.y + b.headH}" x2="${b.x + b.w}" y2="${b.y + b.headH}" stroke="${t.border}" stroke-width="1"/>`);
    b.attrs.forEach(([n, ty], i) => {
      const yy = b.y + b.headH + 20 + i * ROW_H;
      o.push(`<text x="${b.x + PAD_X}" y="${yy}" font-family="Inter" font-size="13"><tspan fill="#1F2937">${esc(n)}${ty ? ":" : ""}</tspan>${ty ? `<tspan fill="${SOFT}"> ${esc(ty)}</tspan>` : ""}</text>`);
    });
  }
  return o.join("\n");
}

function pathD(e, hops) {
  let d = `M${e.pts[0][0]},${e.pts[0][1]}`;
  segs(e).forEach(([p, q, si]) => {
    const xs = hops.get(`${e.i}:${si}`) || [];
    if (xs.length && p[1] === q[1]) {
      const s = q[0] > p[0] ? 1 : -1;
      for (const x of [...new Set(xs)].sort((a, b) => s * (a - b)))
        d += ` L${x - s * HOP},${p[1]} A${HOP},${HOP} 0 0 ${s > 0 ? 1 : 0} ${x + s * HOP},${p[1]}`;
    }
    d += ` L${q[0]},${q[1]}`;
  });
  return d;
}

function cardSvg(c) {
  return `<text x="${c.tx}" y="${c.ty}" text-anchor="${c.anchor}" font-family="Inter" font-size="12" fill="${INK}">${esc(c.text)}</text>`;
}

function headSvg(p, side, kind) {
  // arrow tip at p, pointing into the box on `side`
  const dir = { T: [0, 1], B: [0, -1], L: [1, 0], R: [-1, 0] }[side];
  const [dx, dy] = dir, len = kind === "inherit" ? 13 : 10, half = kind === "inherit" ? 7 : 5;
  const bx = p.x - dx * len, by = p.y - dy * len;
  const pts = `${p.x},${p.y} ${bx - dy * half},${by - dx * half} ${bx + dy * half},${by + dx * half}`;
  return `<polygon points="${pts}" fill="${kind === "inherit" ? "#FFFFFF" : LINE}" stroke="${LINE}" stroke-width="1.3"/>`;
}

// Labels go where nothing else is: both sides of every segment are tried, and
// lines, boxes, cardinalities, other labels and the picture's edge count against
// a spot. Used while choosing routes too, so a route that leaves no room for its
// label loses.
function placeLabels(model, geo) {
  const inner = { x: MARGIN + (model.bands.size ? GUTTER : 0), y: MARGIN / 2 };
  inner.w = geo.width - MARGIN - inner.x;
  inner.h = geo.height - MARGIN / 2 - inner.y;
  const segRect = ([p, q]) => ({ x: Math.min(p[0], q[0]) - 1, y: Math.min(p[1], q[1]) - 1, w: Math.abs(q[0] - p[0]) + 2, h: Math.abs(q[1] - p[1]) + 2 });
  const boxes = [...model.boxes.values()].map((b) => ({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }));
  const placed = cards(model).map((c) => ({ ...c, card: true }));
  const out = [], warnings = [];
  let cost = 0;
  for (const e of model.edges) {
    if (!e.label) continue;
    const w = measure.regular(e.label, 12) + 10, h = 17;
    const others = model.edges.filter((f) => f !== e).flatMap((f) => segs(f).map(segRect));
    let best = null;
    for (const sg of segs(e)) {
      // its own line counts too, except the piece the label hangs on
      const own = segs(e).filter((o) => o[2] !== sg[2]).map(segRect);
      const [p, q] = sg, vertical = p[0] === q[0];
      const len = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
      if (len < (vertical ? 24 : 40)) continue;
      for (const t of [0.5, 0.35, 0.65, 0.2, 0.8])
        for (const flip of [false, true]) {
          const x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t;
          const r = vertical
            ? (flip ? { x: x - 6 - w, y: y - 9, w, h, tx: x - 1 - w, ty: y + 4, anchor: "start" } : { x: x + 6, y: y - 9, w, h, tx: x + 11, ty: y + 4, anchor: "start" })
            : (flip ? { x: x - w / 2, y: y + 3, w, h, tx: x, ty: y + 16, anchor: "middle" } : { x: x - w / 2, y: y - h - 3, w, h, tx: x, ty: y - 7, anchor: "middle" });
          const outside = r.x < inner.x || r.x + r.w > inner.x + inner.w || r.y < inner.y || r.y + r.h > inner.y + inner.h;
          const score = [...others, ...own].filter((o) => overlap(r, o)).length * 10 + boxes.filter((o) => overlap(r, o)).length * 25
            + placed.filter((o) => overlap(r, o)).length * 25 + (outside ? 40 : 0) + (flip ? 1 : 0) + Math.abs(t - 0.5) * 2;
          if (!best || score < best.score) best = { ...r, score, own };
        }
    }
    if (!best) { const [p, q] = segs(e)[0]; best = { x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2 - h, w, h, tx: (p[0] + q[0]) / 2, ty: (p[1] + q[1]) / 2 - 5, anchor: "middle", score: 50 }; }
    for (const c of placed.filter((o) => o.card && overlap(best, o))) warnings.push(`label "${e.label}" overlaps cardinality ${c.text} (${c.e.from} - ${c.e.to})`);
    if (boxes.some((o) => overlap(best, o))) warnings.push(`label "${e.label}" sits on a box`);
    if ((best.own || []).some((o) => overlap(best, o))) warnings.push(`label "${e.label}" covers its own line`);
    cost += best.score > 5 ? best.score : 0;
    placed.push(best);
    out.push({ e, ...best });
  }
  return { labels: out, warnings, cost };
}

function labelSvg(l) {
  return `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="3" fill="#FFFFFF" fill-opacity="0.94"/><text x="${l.tx}" y="${l.ty}" text-anchor="${l.anchor}" font-family="Inter" font-size="12" fill="${LABEL}">${esc(l.e.label)}</text>`;
}

function svg(model, res) {
  const { width, height, bandRects } = res.geo;
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`, `<rect width="100%" height="100%" fill="#FFFFFF"/>`];
  for (const br of bandRects) {
    const band = model.bands.get(br.band);
    const t = TONES[band.tone || "blue"] || TONES.blue;
    o.push(`<rect x="${br.x}" y="${br.top}" width="${br.w}" height="${br.bottom - br.top}" rx="10" fill="${t.band}" stroke="${t.bandline}" stroke-width="1.2"/>`);
    const tx = br.x + 22, ty = (br.top + br.bottom) / 2;
    if (measure.semibold(band.label || band.id, 14) > br.bottom - br.top - 16) res.warnings.push(`band label "${band.label || band.id}" is longer than its band is high; shorten it`);
    o.push(`<text x="${tx}" y="${ty}" transform="rotate(-90 ${tx} ${ty})" text-anchor="middle" font-family="Inter SemiBold" font-size="14" letter-spacing="0.5" fill="${LABEL}">${esc(band.label || band.id)}</text>`);
  }
  for (const e of model.edges) o.push(`<path d="${pathD(e, res.hops)}" fill="none" stroke="${LINE}" stroke-width="1.3"/>`);
  for (const b of model.boxes.values()) o.push(boxSvg(b));
  const cs = cards(model);
  for (const e of model.edges) {
    const inherit = e.kind === "inheritance";
    if (inherit) o.push(headSvg(e.pb, e.pb.side, "inherit"));
    if (e.arrow === "to" || e.arrow === "both") o.push(headSvg(e.pb, e.pb.side, "arrow"));
    if (e.arrow === "from" || e.arrow === "both") o.push(headSvg(e.pa, e.pa.side, "arrow"));
  }
  for (const c of cs) o.push(cardSvg(c));
  const lp = placeLabels(model, res.geo);
  res.warnings.push(...lp.warnings);
  for (const l of lp.labels) o.push(labelSvg(l));
  o.push("</svg>");
  return o.join("\n");
}

// ------------------------------------------------------------ rasterise ----

function loadResvg() {
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "monoceros-discovery", "resvg");
  const req = createRequire(join(dir, "package.json"));
  try { return req("@resvg/resvg-js"); } catch { /* install below */ }
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), '{"private":true}\n');
  try {
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "--prefix", dir, RESVG_SPEC], { stdio: ["ignore", "ignore", "pipe"], timeout: 120000 });
  } catch (err) {
    const npmSays = String(err.stderr || "").split("\n").map((l) => l.replace(/^npm (error|ERR!)\s*/, "").trim()).filter((l) => l && !/^(A complete log|code |errno |syscall )/.test(l)).slice(0, 2).join(" ");
    const why = err.code === "ETIMEDOUT" ? "npm timed out after 120 s" : err.code === "ENOENT" ? "npm is not installed" : npmSays || err.message;
    console.log(JSON.stringify({ ok: false, errors: [`could not install ${RESVG_SPEC} into ${dir}: ${why}. The renderer needs the npm registry once; the SVG was written if --svg was given.`] }, null, 2));
    process.exit(1);
  }
  return req("@resvg/resvg-js");
}

// ------------------------------------------------------------------ main ----

const args = process.argv.slice(2);
if (args.length < 2) { console.error("usage: node diagram.mjs <spec.json> <out.png> [--svg <out.svg>]"); process.exit(2); }
const model = readSpec(args[0]);
for (const b of model.boxes.values()) sizeBox(b, b.band ? model.bands.get(b.band).tone : null);
model.R = Math.max(...[...model.boxes.values()].map((b) => b.row)) + 1;
model.C = Math.max(...[...model.boxes.values()].map((b) => b.col)) + 1;
const res = solve(model);
const out = svg(model, res);
const svgAt = args.indexOf("--svg");
if (svgAt > 0) writeFileSync(args[svgAt + 1], out);
const { Resvg } = loadResvg();
const png = new Resvg(out, { fitTo: { mode: "zoom", value: 2 }, background: "#FFFFFF", font: { fontFiles: [FONT_REGULAR, FONT_SEMIBOLD], loadSystemFonts: false, defaultFontFamily: "Inter" } }).render();
writeFileSync(args[1], png.asPng());
// hints are spots to look at, not errors: at a hub three ends on one side are
// often unavoidable, so they stay out of `warnings`, which must be empty
const SIDE = { T: "top", B: "bottom", L: "left", R: "right" };
const hints = [...res.geo.sideCounts].filter(([, n]) => n >= 3).map(([k, n]) => { const [id, side] = k.split(":"); return `${n} line ends on the ${SIDE[side]} of ${id}`; });
hints.push(...res.detours, ...res.geo.widened);
console.log(JSON.stringify({ ok: true, png: args[1], width: png.width, height: png.height, crossings: res.crossings, warnings: res.warnings, hints }, null, 2));
