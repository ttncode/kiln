/*! LaneFlow v1.1 — swimlane flowchart renderer (Sugiyama + lane constraint).
 * Embed like mermaid:  <script src="laneflow.js"></script>
 *                      <pre class="laneflow"> ...DSL... </pre>
 * Works from file:// — no dependencies, no network.
 * API: LaneFlow.init(root?) / LaneFlow.mount(el, dsl, opts) / LaneFlow.render(dsl)
 */
(function (global) {
'use strict';

/* =====================================================================
   LaneFlow engine — Sugiyama framework with swimlane constraint
   1. parse()   DSL -> {lanes, nodes, edges}
   2. ranks()   cycle removal (DFS back-edge reversal) + longest-path per
                component; dashed cross-lane edges snap-align whole
                components via median relaxation (global ranks across lanes)
   3. order()   barycenter sweeps; sort key #1 = lane (invariant),
                key #2 = barycenter -> nodes never leave their lane band
   4. coords()  rank -> column X; (lane,row) -> Y; rows top-compacted
   5. route()   port discipline: solid same-lane uses left/right ports,
                dashed cross-lane uses top/bottom ports; orthogonal paths
                through corridors (lane gaps / column gaps) + nudging
   6. render()  SVG
   ===================================================================== */
'use strict';

const CFG = { margin: 28, stripW: 27, lanePadX: 30, lanePadY: 26, colGap: 64, rowGap: 34, laneGap: 46 };
const SANS = "ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif";

/* ---------- text measurement ---------- */
const mctx = document.createElement('canvas').getContext('2d');
function textW(s, font) { mctx.font = font || ('500 12.5px ' + SANS); return mctx.measureText(s).width; }
function wrap(text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (textW(t) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- 1. parse ---------- */
function parse(src) {
  const model = { title: '', lanes: [], laneIdx: Object.create(null), nodes: new Map(), order: [], edges: [], errors: [], i18n: {} };
  const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#c026d3', '#dc2626', '#0d9488', '#7c3aed', '#475569'];
  let curI18n = null;
  src.split(/\r?\n/).forEach((raw, li) => {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    if (line.startsWith('%%')) {
      // %%i18n <locale> opens a translation block: "original = translation"
      // per line, applied to title / lane titles / node & edge labels.
      // %%end (or any other %% directive) closes it.
      const mi = line.match(/^%%i18n\s+([A-Za-z0-9_-]+)\s*$/);
      if (mi) { curI18n = mi[1]; if (!model.i18n[curI18n]) model.i18n[curI18n] = {}; }
      else curI18n = null;
      return;
    }
    if (curI18n) {
      const eq = line.indexOf('=');
      if (eq > 0) model.i18n[curI18n][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      else model.errors.push('line ' + (li + 1) + ': i18n entry must be "original = translation"');
      return;
    }
    // inline ' //' comment — only outside quoted strings
    let ci = -1, from = 0;
    while ((ci = line.indexOf(' //', from)) >= 0) {
      const quotes = (line.slice(0, ci).match(/"/g) || []).length;
      if (quotes % 2 === 0) { line = line.slice(0, ci).trim(); break; }
      from = ci + 3;
    }
    const err = m => model.errors.push('line ' + (li + 1) + ': ' + m);
    let m;
    if ((m = line.match(/^title\s+(.+)$/))) { model.title = m[1].replace(/^"|"$/g, ''); return; }
    if ((m = line.match(/^lane\s+([\w.-]+)\s+"([^"]*)"\s*(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))?\s*$/))) {
      if (model.laneIdx[m[1]] !== undefined) return err('duplicate lane "' + m[1] + '"');
      model.laneIdx[m[1]] = model.lanes.length;
      model.lanes.push({ id: m[1], title: m[2], color: m[3] || PALETTE[model.lanes.length % PALETTE.length] });
      return;
    }
    if ((m = line.match(/^node\s+([\w.-]+)\s+([\w.-]+)\s+"([^"]*)"\s*(.*)$/))) {
      const id = m[1], lane = m[2], label = m[3], attrs = m[4];
      if (model.nodes.has(id)) return err('duplicate node "' + id + '"');
      if (model.laneIdx[lane] === undefined) return err('node "' + id + '": unknown lane "' + lane + '"');
      const n = { id, lane, laneIdx: model.laneIdx[lane], label, shape: 'rect', icon: null, pin: null, declIdx: model.order.length };
      for (const kv of attrs.split(/\s+/).filter(Boolean)) {
        const eq = kv.indexOf('='); const k = eq < 0 ? kv : kv.slice(0, eq); const v = eq < 0 ? '' : kv.slice(eq + 1);
        if (k === 'shape') n.shape = v;
        else if (k === 'icon') n.icon = v;
        else if (k === 'rank') {
          const p = parseInt(v, 10);
          if (Number.isFinite(p)) n.pin = p; else err('node "' + id + '": rank must be a number, got "' + v + '"');
        }
        else err('node "' + id + '": unknown attr "' + kv + '"');
      }
      if (!['rect', 'diamond', 'circle'].includes(n.shape)) { err('node "' + id + '": bad shape "' + n.shape + '"'); n.shape = 'rect'; }
      model.nodes.set(id, n); model.order.push(n); return;
    }
    if (/->/.test(line)) {
      let label = null, rest = line;
      const lm = line.match(/^(.*?)\s*:\s*(.+)$/);
      if (lm) { rest = lm[1]; label = lm[2].replace(/^"|"$/g, ''); }
      const parts = rest.split(/\s*(-\.->|-->|->)\s*/).filter(s => s !== '');
      if (parts.length < 3 || parts.length % 2 === 0) return err('malformed edge: "' + line + '"');
      for (let i = 0; i + 2 <= parts.length - 1; i += 2) {
        const from = parts[i], arrow = parts[i + 1], to = parts[i + 2];
        if (!/^(-\.->|-->|->)$/.test(arrow)) { err('bad arrow in "' + line + '"'); continue; }
        if (!model.nodes.has(from)) { err('edge: unknown node "' + from + '"'); continue; }
        if (!model.nodes.has(to)) { err('edge: unknown node "' + to + '"'); continue; }
        if (from === to) { err('self-loop "' + from + '" ignored'); continue; }
        model.edges.push({ from, to, style: arrow === '-.->' ? 'dashed' : 'solid', label: (i + 2 === parts.length - 1) ? label : null, idx: model.edges.length });
      }
      return;
    }
    err('cannot parse: "' + line + '"');
  });
  return model;
}

/* ---------- node sizing ---------- */
function sizeNodes(model) {
  for (const n of model.order) {
    if (n.shape === 'rect') {
      n.lines = wrap(n.label, 150);
      const w = Math.max.apply(null, n.lines.map(s => textW(s))) + 34;
      n.shapeW = clamp(w, 118, 196);
      n.shapeH = Math.max(52, n.lines.length * 17 + 26);
      n.blockW = n.shapeW; n.blockH = n.shapeH;
    } else {
      const s = n.shape === 'diamond' ? 52 : 42;
      n.lines = n.label ? wrap(n.label, 140) : [];
      n.shapeW = s; n.shapeH = s;
      const lw = n.lines.length ? Math.max.apply(null, n.lines.map(s2 => textW(s2, '12px ' + SANS))) : 0;
      n.blockW = Math.max(s, lw + 8);
      n.blockH = s + (n.lines.length ? 7 + n.lines.length * 15 : 0);
    }
  }
}

/* ---------- 2. ranks ---------- */
function sameLane(model, e) { return model.nodes.get(e.from).laneIdx === model.nodes.get(e.to).laneIdx; }

function ranks(model) {
  const rankEdges = model.edges.filter(e => e.style === 'solid' || sameLane(model, e));
  const snapEdges = model.edges.filter(e => e.style === 'dashed' && !sameLane(model, e));

  // components (union-find over ranking edges)
  const uf = new Map(model.order.map(n => [n.id, n.id]));
  const find = x => { while (uf.get(x) !== x) { uf.set(x, uf.get(uf.get(x))); x = uf.get(x); } return x; };
  rankEdges.forEach(e => { const a = find(e.from), b = find(e.to); if (a !== b) uf.set(a, b); });
  const comps = new Map();
  model.order.forEach(n => {
    const r = find(n.id);
    if (!comps.has(r)) comps.set(r, { nodes: [], edges: [], shift: 0 });
    comps.get(r).nodes.push(n); n.comp = r;
  });
  rankEdges.forEach(e => comps.get(find(e.from)).edges.push(e));

  // per-component: cycle removal + longest path
  for (const c of comps.values()) {
    const ids = new Set(c.nodes.map(n => n.id));
    const eff = c.edges.map(e => ({ u: e.from, v: e.to }));
    const adj = new Map([...ids].map(id => [id, []]));
    eff.forEach(a => adj.get(a.u).push(a));
    const color = new Map();
    const stack = [];
    for (const n of c.nodes) {
      if (color.get(n.id)) continue;
      stack.push([n.id, 0]); color.set(n.id, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const u = top[0], list = adj.get(u);
        if (top[1] < list.length) {
          const a = list[top[1]++];
          if (a.u !== u) continue;                       // was reversed away
          const w = a.v;
          if (color.get(w) === 1) { const t = a.u; a.u = a.v; a.v = t; } // back edge -> reverse
          else if (!color.get(w)) { color.set(w, 1); stack.push([w, 0]); }
        } else { color.set(u, 2); stack.pop(); }
      }
    }
    // Kahn longest-path
    const indeg = new Map([...ids].map(id => [id, 0]));
    const out = new Map([...ids].map(id => [id, []]));
    eff.forEach(a => { indeg.set(a.v, indeg.get(a.v) + 1); out.get(a.u).push(a.v); });
    const rank = new Map([...ids].map(id => [id, 0]));
    const q = [...ids].filter(id => !indeg.get(id));
    while (q.length) {
      const u = q.shift();
      for (const v of out.get(u)) {
        rank.set(v, Math.max(rank.get(v), rank.get(u) + 1));
        indeg.set(v, indeg.get(v) - 1);
        if (!indeg.get(v)) q.push(v);
      }
    }
    c.nodes.forEach(n => { n.local = rank.get(n.id) || 0; });
  }

  // anchor = biggest component; others snap-align via dashed cross-lane edges.
  // BFS from the anchor: each component aligns (median) only to components
  // already placed, so mutual pulls between floating components can't dilute
  // the pull coming from the anchored flow. Ties round toward the left.
  let anchor = null;
  for (const [r, c] of comps) if (!anchor || c.nodes.length > comps.get(anchor).nodes.length) anchor = r;
  const g = id => { const n = model.nodes.get(id); return comps.get(n.comp).shift + n.local; };
  const median = des => {
    des.sort((a, b) => a - b);
    const mid = des.length % 2 ? des[(des.length - 1) / 2]
      : (des[des.length / 2 - 1] + des[des.length / 2]) / 2;
    return Math.ceil(mid - 0.5);
  };
  // flow components (having ranking edges) stay left-packed (shift >= 0, Eraser
  // behavior for e.g. UI->system triggers); pure floating components may shift
  // negative for exact column alignment — normalization re-zeroes afterwards
  const applyShift = (c, s) => { c.shift = c.edges.length ? Math.max(0, s) : s; };
  {
    const apins = [];
    comps.get(anchor).nodes.forEach(n => { if (n.pin != null) apins.push(n.pin - n.local); });
    if (apins.length) comps.get(anchor).shift = median(apins);
  }
  const compAdj = new Map([...comps.keys()].map(k => [k, new Set()]));
  snapEdges.forEach(e => {
    const a = model.nodes.get(e.from).comp, b = model.nodes.get(e.to).comp;
    if (a !== b) { compAdj.get(a).add(b); compAdj.get(b).add(a); }
  });
  const placed = new Set([anchor]);
  const queue = [anchor];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of compAdj.get(cur)) {
      if (placed.has(nb)) continue;
      const des = [];
      for (const e of snapEdges) {
        const cu = model.nodes.get(e.from).comp, cv = model.nodes.get(e.to).comp;
        if (cu === nb && cv !== nb && placed.has(cv)) des.push(g(e.to) - model.nodes.get(e.from).local);
        else if (cv === nb && cu !== nb && placed.has(cu)) des.push(g(e.from) - model.nodes.get(e.to).local);
      }
      for (const n of comps.get(nb).nodes) if (n.pin != null) des.push(n.pin - n.local, n.pin - n.local, n.pin - n.local);
      if (des.length) applyShift(comps.get(nb), median(des));
      placed.add(nb); queue.push(nb);
    }
  }
  // components unreachable from the anchor: honor pins, else stay at 0
  for (const [r, c] of comps) {
    if (placed.has(r)) continue;
    const des = [];
    c.nodes.forEach(n => { if (n.pin != null) des.push(n.pin - n.local); });
    if (des.length) applyShift(c, median(des));
  }
  let min = Infinity;
  model.order.forEach(n => { n.rank = comps.get(n.comp).shift + n.local; min = Math.min(min, n.rank); });
  model.order.forEach(n => { n.rank -= min; });
  model.maxRank = model.order.length ? Math.max.apply(null, model.order.map(n => n.rank)) : 0;
}

/* ---------- 3. order (barycenter, lane-constrained) ---------- */
function order(model) {
  const cells = new Map();
  model.order.forEach(n => {
    const k = n.laneIdx + '|' + n.rank;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(n);
  });
  cells.forEach(arr => arr.forEach((n, i) => { n.row = i; }));
  const adj = new Map(model.order.map(n => [n.id, []]));
  model.edges.forEach(e => { adj.get(e.from).push(e.to); adj.get(e.to).push(e.from); });
  const pos = n => n.laneIdx * 1000 + n.row * 10;
  for (let s = 0; s < 6; s++) {
    for (const arr of cells.values()) {
      if (arr.length < 2) continue;
      const bary = new Map(arr.map(n => {
        const nb = adj.get(n.id).map(id => model.nodes.get(id));
        return [n.id, nb.length ? nb.reduce((a, m) => a + pos(m), 0) / nb.length : pos(n)];
      }));
      arr.sort((a, b) => bary.get(a.id) - bary.get(b.id) || a.declIdx - b.declIdx);
      arr.forEach((n, i) => { n.row = i; });
    }
  }
  model.cells = cells;
}

/* ---------- 4. coords ---------- */
function coords(model, C) {
  const L = {};
  const nCols = model.maxRank + 1;
  const colW = new Array(nCols).fill(90);
  model.order.forEach(n => { colW[n.rank] = Math.max(colW[n.rank], n.blockW); });
  let x = C.margin + C.stripW + C.lanePadX;
  L.cols = [];
  for (let r = 0; r < nCols; r++) { L.cols.push({ x0: x, x1: x + colW[r], cx: x + colW[r] / 2 }); x += colW[r] + C.colGap; }
  L.width = L.cols[nCols - 1].x1 + C.lanePadX + C.margin;
  const edgePad = Math.min(C.colGap / 2, C.lanePadX - 8); // stay inside lane border
  L.gapX = k => k < 0 ? L.cols[0].x0 - edgePad
    : (k >= nCols - 1 ? L.cols[nCols - 1].x1 + edgePad : (L.cols[k].x1 + L.cols[k + 1].x0) / 2);

  const topY = C.margin + (model.title ? 30 : 0);
  // corridor load: cross edges turning in each lane gap, per direction — busy
  // corridors get taller gaps so parallel rails and labels can breathe
  const nL = model.lanes.length;
  const loadD = new Array(Math.max(0, nL - 1)).fill(0);
  const loadU = new Array(Math.max(0, nL - 1)).fill(0);
  const backs = new Array(nL).fill(0);
  for (const e of model.edges) {
    const u = model.nodes.get(e.from), v = model.nodes.get(e.to);
    if (!u || !v) continue;
    if (u.laneIdx === v.laneIdx) { if (v.rank < u.rank) backs[u.laneIdx]++; continue; }
    const down = v.laneIdx > u.laneIdx;
    const c1 = down ? u.laneIdx : u.laneIdx - 1;
    const c2 = down ? v.laneIdx - 1 : v.laneIdx;
    const tgt = down ? loadD : loadU;
    tgt[c1]++; if (c2 !== c1) tgt[c2]++;
  }
  L.gaps = loadD.map((d, i) => Math.max(C.laneGap, 2 * (14 + 11 * (Math.max(d, loadU[i], 1) - 1))));
  L.rExtra = backs.map(b => Math.max(0, b - 1) * 9);
  L.lanes = []; let y = topY;
  model.lanes.forEach((lane, i) => {
    const nodesIn = model.order.filter(n => n.laneIdx === i);
    const rows = Math.max(1, ...nodesIn.map(n => n.row + 1));
    const maxBlockH = Math.max(48, ...nodesIn.map(n => n.blockH));
    const slotH = maxBlockH + C.rowGap;
    const h = C.lanePadY * 2 + rows * maxBlockH + (rows - 1) * C.rowGap + L.rExtra[i];
    L.lanes.push({ y0: y, y1: y + h, rows, slotH, maxBlockH });
    y += h + (i < nL - 1 ? L.gaps[i] : 0);
  });
  L.height = y + C.margin;
  L.corridorY = i => (L.lanes[i].y1 + L.lanes[i + 1].y0) / 2;
  L.rowBoundY = (li, k) => L.lanes[li].y0 + C.lanePadY + k * L.lanes[li].slotH - C.rowGap / 2;

  model.order.forEach(n => {
    const LB = L.lanes[n.laneIdx];
    n.cx = L.cols[n.rank].cx;
    // all shapes in a row share one center axis so same-row edges run straight;
    // below-labels of circles/diamonds spill into the row gap (masked by plates)
    n.cy = LB.y0 + C.lanePadY + n.row * LB.slotH + LB.maxBlockH / 2;
    n.sy0 = n.cy - n.shapeH / 2; n.sy1 = n.cy + n.shapeH / 2;
    n.sx0 = n.cx - n.shapeW / 2; n.sx1 = n.cx + n.shapeW / 2;
  });

  L.cellNode = new Map();
  model.order.forEach(n => L.cellNode.set(n.laneIdx + '|' + n.rank + '|' + n.row, n));
  L.laneRank = new Map();
  model.order.forEach(n => { const k = n.laneIdx + '|' + n.rank; L.laneRank.set(k, (L.laneRank.get(k) || 0) + 1); });
  return L;
}

/* ---------- 5. route ---------- */
function portPt(n, side, off) {
  // diamond top/bottom with a fractional offset: the port sits ON the
  // diagonal side (|off| = t along tip->corner), dodging a contested tip
  if (n.shape === 'diamond' && off && (side === 'top' || side === 'bottom')) {
    const x = n.cx + off * (n.shapeW / 2);
    const dy = (1 - Math.abs(off)) * (n.shapeH / 2);
    return [x, side === 'top' ? n.sy0 + dy : n.sy1 - dy];
  }
  switch (side) {
    case 'left': return [n.sx0, n.cy + off];
    case 'right': return [n.sx1, n.cy + off];
    case 'top': return [n.cx + off, n.sy0];
    default: return [n.cx + off, n.sy1];
  }
}
function simplify(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = out[out.length - 1];
    if (Math.abs(p[0] - q[0]) < 0.4 && Math.abs(p[1] - q[1]) < 0.4) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    if ((Math.abs(a[0] - b[0]) < 0.4 && Math.abs(b[0] - c[0]) < 0.4) ||
        (Math.abs(a[1] - b[1]) < 0.4 && Math.abs(b[1] - c[1]) < 0.4)) out.splice(i, 1);
  }
  return out;
}

function route(model, L) {
  const N = id => model.nodes.get(id);
  // rows r0..r1 (inclusive) at (lane, rank) free of nodes?
  const vClear = (li, rank, r0, r1) => {
    for (let r = r0; r <= r1; r++) if (L.cellNode.has(li + '|' + rank + '|' + r)) return false;
    return true;
  };
  for (const e of model.edges) {
    const u = N(e.from), v = N(e.to);
    if (u.laneIdx === v.laneIdx) {
      if (v.rank > u.rank) {
        let dia = u.shape === 'diamond' && v.row !== u.row;
        if (dia) {
          // BPMN-style bottom exit only when the drop + run to the target row is clear
          for (let r = u.rank + 1; r < v.rank; r++) if (L.cellNode.has(u.laneIdx + '|' + r + '|' + v.row)) dia = false;
          const lo = Math.min(u.row, v.row) + 1, hi = Math.max(u.row, v.row) - 1;
          if (!vClear(u.laneIdx, u.rank, lo, hi)) dia = false;
        }
        if (dia) e.plan = { kind: 'diamond', exit: v.row > u.row ? 'bottom' : 'top', entry: 'left' };
        else e.plan = { kind: 'fwd', exit: 'right', entry: 'left' };
      } else if (v.rank < u.rank) {
        // dashed back edges loop over the TOP of the row — the space below
        // is usually taken by the solid rework rails
        const above = e.style === 'dashed';
        e.plan = { kind: 'back', above, exit: above ? 'top' : 'bottom', entry: above ? 'top' : 'bottom' };
      }
      else e.plan = { kind: 'vlocal', exit: v.row > u.row ? 'bottom' : 'top', entry: v.row > u.row ? 'top' : 'bottom' };
    } else {
      const down = v.laneIdx > u.laneIdx;
      e.plan = { kind: 'cross', down, exit: down ? 'bottom' : 'top', entry: down ? 'top' : 'bottom' };
    }
  }
  // diamond/circle tip conflicts: their ports are fixed points, so when a
  // cross edge wants a tip that another edge already uses, move the cross
  // edge to a free horizontal tip (routed via the adjacent column gap)
  {
    const cnt = new Map();
    const bump = (id, side, d) => { const k = id + '|' + side; cnt.set(k, (cnt.get(k) || 0) + d); };
    for (const e of model.edges) { bump(e.from, e.plan.exit, 1); bump(model.nodes.get(e.to).id, e.plan.entry, 1); }
    // farther-reaching edges are evicted from contested tips first — the
    // near-lane edge keeps the tip and its short straight-ish route
    const crossEs = model.edges.filter(e => e.plan.kind === 'cross')
      .sort((a, b) => (Math.abs(N(b.from).laneIdx - N(b.to).laneIdx) - Math.abs(N(a.from).laneIdx - N(a.to).laneIdx)) || a.idx - b.idx);
    for (const e of crossEs) {
      const u = N(e.from), v = N(e.to);
      const fix = (node, endKey, otherX) => {
        const side = e.plan[endKey];
        if (node.shape === 'rect' || (side !== 'top' && side !== 'bottom')) return;
        if ((cnt.get(node.id + '|' + side) || 0) < 2) return;
        const prefer = otherX <= node.cx ? ['left', 'right'] : ['right', 'left'];
        for (const cand of prefer) {
          if (!(cnt.get(node.id + '|' + cand) || 0)) {
            bump(node.id, side, -1); bump(node.id, cand, 1);
            e.plan[endKey] = cand;
            return;
          }
        }
      };
      fix(u, 'exit', v.cx);
      fix(v, 'entry', u.cx);
    }
  }
  // port discipline: spread multiple edges on a node side
  const groups = new Map();
  const push = (nid, side, e, end, sortVal) => {
    const k = nid + '|' + side;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ e, end, sortVal });
  };
  for (const e of model.edges) {
    const u = N(e.from), v = N(e.to);
    push(u.id, e.plan.exit, e, 'exit', (e.plan.exit === 'left' || e.plan.exit === 'right') ? v.cy : v.cx);
    push(v.id, e.plan.entry, e, 'entry', (e.plan.entry === 'left' || e.plan.entry === 'right') ? u.cy : u.cx);
  }
  // does this cross edge render as ONE full-height vertical (same column,
  // nothing in the way)? such edges block every rail depth at their x, so
  // they must take the innermost port to keep their straight line
  const fullVert = e2 => {
    if (e2.plan.kind !== 'cross') return false;
    const uu = N(e2.from), vv = N(e2.to);
    if (uu.rank !== vv.rank) return false;
    if (['left', 'right'].includes(e2.plan.exit) || ['left', 'right'].includes(e2.plan.entry)) return false;
    const dwn = e2.plan.down;
    const lo3 = Math.min(uu.laneIdx, vv.laneIdx), hi3 = Math.max(uu.laneIdx, vv.laneIdx);
    for (let l = lo3 + 1; l < hi3; l++) if (L.laneRank.get(l + '|' + uu.rank)) return false;
    if (!(dwn ? vClear(uu.laneIdx, uu.rank, uu.row + 1, L.lanes[uu.laneIdx].rows - 1) : vClear(uu.laneIdx, uu.rank, 0, uu.row - 1))) return false;
    if (!(dwn ? vClear(vv.laneIdx, vv.rank, 0, vv.row - 1) : vClear(vv.laneIdx, vv.rank, vv.row + 1, L.lanes[vv.laneIdx].rows - 1))) return false;
    return true;
  };
  for (const [k, arr] of groups) {
    const n = N(k.split('|')[0]); const side = k.split('|')[1];
    arr.sort((a, b) => a.sortVal - b.sortVal || a.e.idx - b.e.idx);
    const set = (it, off) => { if (it.end === 'exit') it.e.exOff = off; else it.e.enOff = off; };
    if (side === 'bottom') n.busyBottom = arr.length; else if (side === 'top') n.busyTop = arr.length;
    if (n.shape !== 'rect') {
      if (n.shape === 'diamond' && (side === 'top' || side === 'bottom') && arr.length > 1) {
        // contested tip: the same-lane branch keeps the tip, other edges
        // slide onto the diagonal sides toward their counterpart
        const pr = kk => kk === 'cross' ? 1 : 0;
        arr.sort((a, b) => pr(a.e.plan.kind) - pr(b.e.plan.kind) || a.e.idx - b.e.idx);
        const taken = new Set();
        arr.forEach((it, i) => {
          if (i === 0) return set(it, 0);
          const other = N(it.end === 'exit' ? it.e.to : it.e.from);
          let s = Math.sign(other.cx - n.cx) || 1;
          if (taken.has(s) && !taken.has(-s)) s = -s;
          taken.add(s);
          set(it, s * 0.45);
        });
      } else arr.forEach(it => set(it, 0));
      continue;
    }
    if (side === 'top' || side === 'bottom') {
      const half = n.shapeW / 2 - 14;
      if (arr.length === 1) {
        // lean the port toward its counterpart: shorter runs, fewer bends
        const lm = Math.min(half, 28);
        set(arr[0], clamp(arr[0].sortVal - n.cx, -lm, lm));
        continue;
      }
      // nesting order: rails farther from the node take ports farther from
      // their approach side, so parallel approaches never cross each other.
      // exits turn in the corridor half adjacent to the node (shallow);
      // entries turn in the far half (deep); in-lane rails are shallowest.
      const depth = it => {
        const kind = it.e.plan.kind;
        // corridor slots march AWAY from the node for entries but TOWARD the
        // node for exits, so the declaration-order tiebreak flips per end
        if (kind === 'cross') return (fullVert(it.e) ? 3 : (it.end === 'exit' ? 1 : 2)) + (it.end === 'exit' ? -1 : 1) * it.e.idx * 1e-4;
        if (kind === 'back') {
          const uu = N(it.e.from), vv = N(it.e.to);
          return (uu.rank - vv.rank) * 1e-2 + it.e.idx * 1e-4; // longer span = deeper rail
        }
        return it.e.idx * 1e-4;
      };
      const meta = arr.map(it => ({ it, right: it.sortVal >= n.cx, d: depth(it) }));
      meta.sort((a, b) => (a.right === b.right ? (a.right ? b.d - a.d : a.d - b.d) : (a.right ? 1 : -1)));
      const minSep = 16;
      if ((meta.length - 1) * minSep > 2 * half) {
        const step = (2 * half) / (meta.length - 1);
        meta.forEach((m, i) => set(m.it, -half + i * step));
      } else {
        // keep each port as close to its counterpart as the nesting order
        // allows — straight verticals stay straight
        const lm = Math.min(half, 28);
        const pos = meta.map(m => clamp(m.it.sortVal - n.cx, -lm, lm));
        for (let i = 1; i < pos.length; i++) pos[i] = Math.max(pos[i], pos[i - 1] + minSep);
        for (let i = pos.length - 1; i >= 0; i--) pos[i] = Math.min(pos[i], i === pos.length - 1 ? half : pos[i + 1] - minSep);
        meta.forEach((m, i) => set(m.it, clamp(pos[i], -half, half)));
      }
    } else {
      const step = arr.length > 1 ? Math.min(22, (n.shapeH - 16) / (arr.length - 1)) : 0;
      arr.forEach((it, i) => set(it, (i - (arr.length - 1) / 2) * step));
    }
  }
  // corridor nudging: 0, -9, +9, -18, +18… clamped to the corridor width so
  // parallel edges can never be pushed out of the gap into a node column
  const used = new Map();
  const nudge = (key, amt, max) => {
    amt = amt || 9; max = max || 26;
    const c = used.get(key) || 0; used.set(key, c + 1);
    const off = c === 0 ? 0 : Math.ceil(c / 2) * amt * (c % 2 ? -1 : 1);
    return Math.max(-max, Math.min(max, off));
  };
  const CMAX = Math.max(6, CFG.laneGap / 2 - 6);   // horizontal lane corridors
  const RMAX = Math.max(5, CFG.rowGap / 2 - 5);    // row corridors inside a lane
  const GMAX = Math.max(8, CFG.colGap / 2 - 6);    // vertical column gaps
  // bottom row-corridor gets the lane's extra room reserved for back edges
  const rmax = (li, k) => RMAX + (L.rExtra && k === L.lanes[li].rows ? L.rExtra[li] : 0);
  // gaps already promised to tip-moved edges count as occupied up front, so
  // tie-breaking escapes route away from them
  const resv = new Map();
  {
    const rsv = k => resv.set(k, (resv.get(k) || 0) + 1);
    for (const e of model.edges) {
      if (!e.plan || e.plan.kind !== 'cross') continue;
      const uu = N(e.from), vv = N(e.to);
      if (e.plan.exit === 'left') rsv(uu.rank - 1); else if (e.plan.exit === 'right') rsv(uu.rank);
      if (e.plan.entry === 'left') rsv(vv.rank - 1); else if (e.plan.entry === 'right') rsv(vv.rank);
    }
  }
  // pick the emptier of two column gaps when both sides are equally valid
  const pickGap = (a, b) =>
    ((used.get('GV' + a) || 0) + (resv.get(a) || 0)) <= ((used.get('GV' + b) || 0) + (resv.get(b) || 0)) ? a : b;
  // corridor slots partitioned by direction: downward edges turn in the upper
  // half of the corridor, upward edges in the lower half — opposite flows can
  // never share a vertical segment inside the corridor
  const cslot = (ci, down) => {
    const key = 'C' + ci + (down ? 'd' : 'u');
    const c = used.get(key) || 0; used.set(key, c + 1);
    const cap = Math.max(6, ((L.gaps && L.gaps[ci]) || CFG.laneGap) / 2 - 6);
    return L.corridorY(ci) + (down ? -1 : 1) * Math.min(6 + c * 11, cap);
  };
  // vertical-run registry: keeps opposite-direction cross edges that happen to
  // share the same x (e.g. two nodes in the same column) from overlapping —
  // the later edge slides its port a few px along the node border
  const vruns = [];
  const claimV = (x, ya, yb, limit) => {
    const y1 = Math.min(ya, yb), y2 = Math.max(ya, yb);
    let best = x;
    for (let t = 0; t < 7; t++) {
      const cand = x + (t === 0 ? 0 : Math.ceil(t / 2) * 7 * (t % 2 ? 1 : -1));
      if (Math.abs(cand - x) > limit && t > 0) continue;
      if (!vruns.some(r => Math.abs(r.x - cand) < 6 && y2 > r.y1 + 2 && y1 < r.y2 - 2)) { best = cand; break; }
    }
    vruns.push({ x: best, y1, y2 });
    return best;
  };

  // nested rails for solid back edges sharing a row corridor: shorter spans
  // hug the row, longer spans run deeper — their verticals then never cut
  // through an inner rail
  {
    const byCorr = new Map();
    for (const e of model.edges) {
      if (!e.plan || e.plan.kind !== 'back' || e.plan.above) continue;
      const u = N(e.from), v = N(e.to);
      const key = u.laneIdx + ':' + (Math.max(u.row, v.row) + 1);
      if (!byCorr.has(key)) byCorr.set(key, []);
      byCorr.get(key).push({ e, span: u.rank - v.rank });
    }
    for (const [key, list] of byCorr) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.span - b.span || a.e.idx - b.e.idx);
      const li = +key.split(':')[0], k = +key.split(':')[1];
      const cap = rmax(li, k);
      list.forEach((it, i) => {
        // 16px apart so a 16px label plate on one rail cannot cover its neighbour
        it.e.railOff = clamp((i - (list.length - 1) / 2) * 16, -cap, cap);
      });
    }
  }

  for (const e of model.edges) {
    const u = N(e.from), v = N(e.to), p = e.plan;
    const ex = portPt(u, p.exit, e.exOff || 0), en = portPt(v, p.entry, e.enOff || 0);
    let pts;
    if (p.kind === 'fwd') {
      if (u.row === v.row) {
        let blocked = false;
        for (let r = u.rank + 1; r < v.rank; r++) if (L.cellNode.has(u.laneIdx + '|' + r + '|' + u.row)) blocked = true;
        if (!blocked) {
          if (Math.abs(ex[1] - en[1]) < 0.6) pts = [ex, en];
          else { const gx = L.gapX(v.rank - 1) + nudge('G' + (v.rank - 1), 9, GMAX); pts = [ex, [gx, ex[1]], [gx, en[1]], en]; }
        } else {
          const k = u.row + 1;
          const cy = L.rowBoundY(u.laneIdx, k) + nudge('R' + u.laneIdx + ':' + k, 8, rmax(u.laneIdx, k));
          const g1 = L.gapX(u.rank) + nudge('G' + u.rank, 9, GMAX), g2 = L.gapX(v.rank - 1) + nudge('G' + (v.rank - 1), 9, GMAX);
          pts = [ex, [g1, ex[1]], [g1, cy], [g2, cy], [g2, en[1]], en];
        }
      } else if (v.rank === u.rank + 1) {
        const gx = L.gapX(u.rank) + nudge('G' + u.rank, 9, GMAX);
        pts = [ex, [gx, ex[1]], [gx, en[1]], en];
      } else {
        const k = Math.max(u.row, v.row);
        const cy = L.rowBoundY(u.laneIdx, k) + nudge('R' + u.laneIdx + ':' + k, 8, rmax(u.laneIdx, k));
        const g1 = L.gapX(u.rank) + nudge('G' + u.rank, 9, GMAX), g2 = L.gapX(v.rank - 1) + nudge('G' + (v.rank - 1), 9, GMAX);
        pts = [ex, [g1, ex[1]], [g1, cy], [g2, cy], [g2, en[1]], en];
      }
    } else if (p.kind === 'diamond') {
      pts = [ex, [ex[0], en[1]], en];
    } else if (p.kind === 'back') {
      if (p.above) {
        // dashed back edge loops over the top of its row
        const k = Math.min(u.row, v.row);
        const cy = L.rowBoundY(u.laneIdx, k) + nudge('RA' + u.laneIdx + ':' + k, 6, 5);
        pts = [ex, [ex[0], cy], [en[0], cy], en];
      } else {
        const k = Math.max(u.row, v.row) + 1;
        const cy = L.rowBoundY(u.laneIdx, k) + (e.railOff !== undefined
          ? e.railOff : nudge('R' + u.laneIdx + ':' + k, 8, rmax(u.laneIdx, k)));
        pts = [ex, [ex[0], cy], [en[0], cy], en];
      }
    } else if (p.kind === 'vlocal') {
      if (Math.abs(ex[0] - en[0]) < 0.6) pts = [ex, en];
      else { const my = (ex[1] + en[1]) / 2; pts = [ex, [ex[0], my], [en[0], my], en]; }
    } else { // cross
      const down = p.down;
      const diff = Math.abs(v.laneIdx - u.laneIdx);
      const exH = p.exit === 'left' || p.exit === 'right';   // horizontal tip exit
      const enH = p.entry === 'left' || p.entry === 'right'; // horizontal tip entry
      // the vertical run from a top/bottom port must not pierce deeper/higher
      // rows stacked in the same column — escape sideways through a column gap
      const exBlocked = !exH && (down ? !vClear(u.laneIdx, u.rank, u.row + 1, L.lanes[u.laneIdx].rows - 1)
                                      : !vClear(u.laneIdx, u.rank, 0, u.row - 1));
      const enBlocked = !enH && (down ? !vClear(v.laneIdx, v.rank, 0, v.row - 1)
                                      : !vClear(v.laneIdx, v.rank, v.row + 1, L.lanes[v.laneIdx].rows - 1));
      let straight = !exH && !enH && !exBlocked && !enBlocked && Math.abs(ex[0] - en[0]) < 0.6 && u.rank === v.rank;
      if (straight && diff > 1) {
        const lo = Math.min(u.laneIdx, v.laneIdx), hi = Math.max(u.laneIdx, v.laneIdx);
        for (let l = lo + 1; l < hi; l++) if (L.laneRank.get(l + '|' + u.rank)) straight = false;
      }
      if (straight) {
        const lim = Math.min(u.shape === 'rect' ? 12 : 0, v.shape === 'rect' ? 12 : 0);
        const sx = claimV(ex[0], ex[1], en[1], lim);
        pts = [[sx, ex[1]], [sx, en[1]]];
      } else {
        let exitPts = [], exitX = ex[0], exitGc = null;
        if (exH) {
          exitGc = p.exit === 'left' ? u.rank - 1 : u.rank;
          exitX = L.gapX(exitGc) + nudge('GV' + exitGc, 9, GMAX);
          exitPts = [[exitX, ex[1]]];
        } else if (exBlocked) {
          const k = down ? u.row + 1 : u.row;
          const ry = L.rowBoundY(u.laneIdx, k) + nudge('R' + u.laneIdx + ':' + k, 8, rmax(u.laneIdx, k));
          exitGc = Math.abs(en[0] - ex[0]) < 0.6 ? pickGap(u.rank - 1, u.rank)
            : (en[0] > ex[0] ? u.rank : u.rank - 1);
          exitX = L.gapX(exitGc) + nudge('GV' + exitGc, 9, GMAX);
          exitPts = [[ex[0], ry], [exitX, ry]];
        }
        let entryPts = [], entryX = en[0];
        // entry escape picks its gap by where the wire actually APPROACHES
        // from (not where it started) and reuses the approach x when it is
        // already in the right gap — no doubling back, no extra bends
        const mkEntry = (approachX, approachGc) => {
          if (enH) {
            const gc = p.entry === 'left' ? v.rank - 1 : v.rank;
            entryX = (approachGc === gc) ? approachX : L.gapX(gc) + nudge('GV' + gc, 9, GMAX);
            entryPts = [[entryX, en[1]]];
          } else if (enBlocked) {
            const k = down ? v.row : v.row + 1;
            const ry = L.rowBoundY(v.laneIdx, k) + nudge('R' + v.laneIdx + ':' + k, 8, rmax(v.laneIdx, k));
            const gc = Math.abs(approachX - en[0]) < 0.6 ? pickGap(v.rank - 1, v.rank)
              : (approachX > en[0] ? v.rank : v.rank - 1);
            entryX = (approachGc === gc) ? approachX : L.gapX(gc) + nudge('GV' + gc, 9, GMAX);
            entryPts = [[entryX, ry], [en[0], ry]];
          }
        };
        if (diff === 1) {
          const ci = Math.min(u.laneIdx, v.laneIdx);
          const cy = cslot(ci, down);
          if (!exH && !exBlocked) { exitX = claimV(ex[0], ex[1], cy, u.shape === 'rect' ? 12 : 0); ex[0] = exitX; }
          mkEntry(exitX, exitGc);
          if (!enH && !enBlocked) { entryX = claimV(en[0], cy, en[1], v.shape === 'rect' ? 12 : 0); en[0] = entryX; }
          pts = [ex].concat(exitPts, [[exitX, cy], [entryX, cy]], entryPts, [en]);
        } else {
          const c1i = down ? u.laneIdx : u.laneIdx - 1;
          const c2i = down ? v.laneIdx - 1 : v.laneIdx;
          // prefer ONE long straight vertical at the entry (or exit) column
          // over the column-gap dogleg when that column strip is empty —
          // two bends fewer per edge
          const lo2 = Math.min(u.laneIdx, v.laneIdx), hi2 = Math.max(u.laneIdx, v.laneIdx);
          let entryClear = !enH && !enBlocked, exitClear = !exH && !exBlocked;
          for (let l = lo2 + 1; l < hi2; l++) {
            if (L.laneRank.get(l + '|' + v.rank)) entryClear = false;
            if (L.laneRank.get(l + '|' + u.rank)) exitClear = false;
          }
          if (entryClear) {
            const cy1 = cslot(c1i, down);
            if (!exH && !exBlocked) { exitX = claimV(ex[0], ex[1], cy1, u.shape === 'rect' ? 12 : 0); ex[0] = exitX; }
            entryX = claimV(en[0], cy1, en[1], v.shape === 'rect' ? 12 : 0); en[0] = entryX;
            pts = [ex].concat(exitPts, [[exitX, cy1], [entryX, cy1]], [en]);
          } else if (exitClear) {
            const cy2 = cslot(c2i, down);
            exitX = claimV(ex[0], ex[1], cy2, u.shape === 'rect' ? 12 : 0); ex[0] = exitX;
            mkEntry(exitX, null);
            if (!enH && !enBlocked) { entryX = claimV(en[0], cy2, en[1], v.shape === 'rect' ? 12 : 0); en[0] = entryX; }
            pts = [ex].concat([[exitX, cy2], [entryX, cy2]], entryPts, [en]);
          } else {
            const cy1 = cslot(c1i, down);
            const cy2 = c1i === c2i ? cy1 : cslot(c2i, down);
            // stay in the gap the exit escape already chose — fewer bends
            const gcol = exitGc !== null ? exitGc
              : (v.rank > u.rank ? v.rank - 1 : (v.rank < u.rank ? v.rank : u.rank));
            const gx = exitGc === gcol ? exitX : L.gapX(gcol) + nudge('GV' + gcol, 9, GMAX);
            if (!exH && !exBlocked) { exitX = claimV(ex[0], ex[1], cy1, u.shape === 'rect' ? 12 : 0); ex[0] = exitX; }
            mkEntry(gx, gcol);
            if (!enH && !enBlocked) { entryX = claimV(en[0], cy2, en[1], v.shape === 'rect' ? 12 : 0); en[0] = entryX; }
            pts = [ex].concat(exitPts, [[exitX, cy1], [gx, cy1], [gx, cy2], [entryX, cy2]], entryPts, [en]);
          }
        }
      }
    }
    e.pts = simplify(pts);
  }

  // ---- gap-slot optimizer ----------------------------------------------
  // verticals sharing a column gap were slotted in declaration order; try
  // every permutation of the used x-slots and keep the assignment with the
  // fewest rail x vertical crossings (narrow loops end up inside, long
  // through-runs outside)
  {
    const nCols2 = model.maxRank + 1;
    const bandOf = x => {
      for (let k2 = -1; k2 <= nCols2 - 1; k2++)
        if (Math.abs(x - L.gapX(k2)) <= CFG.colGap / 2 - 4) return k2;
      return null;
    };
    const bands = new Map();
    for (const e of model.edges) {
      if (!e.pts) continue;
      for (let i = 1; i < e.pts.length - 2; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        if (Math.abs(a[0] - b[0]) >= 0.4) continue;      // verticals only
        const k2 = bandOf(a[0]);
        if (k2 === null) continue;
        if (!bands.has(k2)) bands.set(k2, []);
        bands.get(k2).push({ e, i });
      }
    }
    const crossHV = (h, v2) => {
      const y = h[0][1], x1 = Math.min(h[0][0], h[1][0]), x2 = Math.max(h[0][0], h[1][0]);
      const x = v2[0][0], y1 = Math.min(v2[0][1], v2[1][1]), y2 = Math.max(v2[0][1], v2[1][1]);
      return x > x1 + 0.5 && x < x2 - 0.5 && y > y1 + 0.5 && y < y2 - 0.5;
    };
    for (const [k2, list] of bands) {
      if (list.length < 2 || list.length > 5) continue;
      const xs = list.map(it => it.e.pts[it.i][0]);
      const lo3 = Math.min(...xs) - 1, hi3 = Math.max(...xs) + 1;
      // static horizontals of other edges crossing this band
      const statics = [];
      for (const e of model.edges) {
        if (!e.pts) continue;
        for (let i = 0; i < e.pts.length - 1; i++) {
          if (Math.abs(e.pts[i][1] - e.pts[i + 1][1]) >= 0.4) continue;
          if (list.some(it => it.e === e && (i === it.i - 1 || i === it.i + 1))) continue; // moving rails
          const xa = Math.min(e.pts[i][0], e.pts[i + 1][0]), xb = Math.max(e.pts[i][0], e.pts[i + 1][0]);
          if (xb >= lo3 && xa <= hi3) statics.push([e.pts[i], e.pts[i + 1]]);
        }
      }
      const geoOf = (it, x) => {
        const p = it.e.pts;
        return {
          prev: [[p[it.i - 1][0], p[it.i - 1][1]], [x, p[it.i][1]]],
          vert: [[x, p[it.i][1]], [x, p[it.i + 1][1]]],
          next: [[x, p[it.i + 1][1]], [p[it.i + 2][0], p[it.i + 2][1]]],
        };
      };
      const count = assign => {
        const geo = list.map((it, idx) => geoOf(it, assign[idx]));
        let c = 0;
        for (let a2 = 0; a2 < geo.length; a2++) for (let b2 = 0; b2 < geo.length; b2++) {
          if (a2 === b2) continue;
          if (crossHV(geo[a2].prev, geo[b2].vert)) c++;
          if (crossHV(geo[a2].next, geo[b2].vert)) c++;
        }
        for (const g2 of geo) for (const st of statics) if (crossHV(st, g2.vert)) c++;
        return c;
      };
      const perm = arr => arr.length <= 1 ? [arr]
        : arr.flatMap((v2, i2) => perm(arr.slice(0, i2).concat(arr.slice(i2 + 1))).map(r => [v2].concat(r)));
      let best = xs, bestC = count(xs);
      for (const p2 of perm(xs)) {
        const c2 = count(p2);
        if (c2 < bestC) { bestC = c2; best = p2; }
        if (!bestC) break;
      }
      if (best !== xs) list.forEach((it, idx) => {
        it.e.pts[it.i][0] = best[idx];
        it.e.pts[it.i + 1][0] = best[idx];
      });
    }
  }
}

/* ---------- 6. render ---------- */
const ICONS = {
  play: [['p', 'M8 5.5l11 6.5-11 6.5z', 'f']],
  mail: [['r', 3, 5, 18, 14, 2], ['p', 'M3 7l9 6 9-6']],
  cursor: [['p', 'M5 3l7 17 2.2-7.3L21.5 10z', 'f']],
  check: [['p', 'M4.5 12.5l5 5L19.5 6.5']],
  warn: [['p', 'M12 3.5L22 20H2z'], ['p', 'M12 9.5v4.5'], ['p', 'M12 16.9v.4']],
  x: [['p', 'M6 6l12 12'], ['p', 'M18 6L6 18']],
  doc: [['p', 'M6.5 3h8l4 4v14h-12z'], ['p', 'M14.5 3v4h4']],
  scissors: [['c', 6, 7, 2.6], ['c', 6, 17, 2.6], ['p', 'M8.3 8.6L20 19'], ['p', 'M8.3 15.4L20 5']],
  person: [['c', 12, 8, 3.6], ['p', 'M4.5 20c1.6-4.2 4.3-6 7.5-6s5.9 1.8 7.5 6']],
  list: [['p', 'M9 6h11'], ['p', 'M9 12h11'], ['p', 'M9 18h11'], ['p', 'M4.5 6h.01'], ['p', 'M4.5 12h.01'], ['p', 'M4.5 18h.01']],
  fileplus: [['p', 'M6.5 3h8l4 4v14h-12z'], ['p', 'M14.5 3v4h4'], ['p', 'M12 11v6'], ['p', 'M9 14h6']],
  save: [['p', 'M5 3h11l3.5 3.5V21H5z'], ['p', 'M8 21v-7h8v7'], ['p', 'M8 3v5h6']],
  db: [['e', 12, 5.5, 7, 2.6], ['p', 'M5 5.5v13c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7v-13'], ['p', 'M5 12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7']],
  inbox: [['p', 'M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5'], ['p', 'M3.5 13.5V19h17v-5.5'], ['p', 'M6 13.5L7.5 5.5h9l1.5 8']],
  gear: [['c', 12, 12, 3.2], ['p', 'M12 2.5v3'], ['p', 'M12 18.5v3'], ['p', 'M2.5 12h3'], ['p', 'M18.5 12h3'], ['p', 'M5.3 5.3l2.1 2.1'], ['p', 'M16.6 16.6l2.1 2.1'], ['p', 'M18.7 5.3l-2.1 2.1'], ['p', 'M7.4 16.6l-2.1 2.1']],
  chart: [['p', 'M4 20h16'], ['r', 6, 11, 3, 9], ['r', 11, 7, 3, 13], ['r', 16, 4, 3, 16]],
  arrow: [['c', 12, 12, 9], ['p', 'M8 12h7'], ['p', 'M12.5 8.5L16 12l-3.5 3.5']]
};
const ICON_ALIAS = { email: 'mail', click: 'cursor', warning: 'warn', database: 'db', file: 'doc', document: 'doc', settings: 'gear', user: 'person', process: 'arrow', log: 'doc', error: 'warn' };
function iconSvg(name, x, y, size, color) {
  const defs = ICONS[ICON_ALIAS[name] || name];
  if (!defs) return '';
  const s = size / 24;
  let out = '<g transform="translate(' + r2(x) + ',' + r2(y) + ') scale(' + r2(s) + ')" stroke="' + color + '" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">';
  for (const d of defs) {
    if (d[0] === 'p') out += '<path d="' + d[1] + '"' + (d[2] === 'f' ? ' fill="' + color + '" stroke="none"' : '') + '/>';
    else if (d[0] === 'c') out += '<circle cx="' + d[1] + '" cy="' + d[2] + '" r="' + d[3] + '"/>';
    else if (d[0] === 'e') out += '<ellipse cx="' + d[1] + '" cy="' + d[2] + '" rx="' + d[3] + '" ry="' + d[4] + '"/>';
    else if (d[0] === 'r') out += '<rect x="' + d[1] + '" y="' + d[2] + '" width="' + d[3] + '" height="' + d[4] + '" rx="' + (d[5] || 0) + '"/>';
  }
  return out + '</g>';
}

const r2 = v => Math.round(v * 100) / 100;
const fpt = p => r2(p[0]) + ' ' + r2(p[1]);
const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
function towards(from, to, d) {
  const dx = Math.sign(to[0] - from[0]), dy = Math.sign(to[1] - from[1]);
  return [from[0] + dx * d, from[1] + dy * d];
}
function orthoPath(pts, r) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return 'M' + fpt(pts[0]) + ' L' + fpt(pts[1]);
  let d = 'M' + fpt(pts[0]);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const rr = Math.min(r, dist(a, b) / 2, dist(b, c) / 2);
    d += ' L' + fpt(towards(b, a, rr)) + ' Q' + fpt(b) + ' ' + fpt(towards(b, c, rr));
  }
  return d + ' L' + fpt(pts[pts.length - 1]);
}

/* line jumps: every orthogonal crossing is horizontal x vertical, so letting
   horizontal segments hop over vertical ones covers all crossings exactly once */
function computeJumps(model) {
  const verts = [];
  for (const e of model.edges) {
    if (!e.pts) continue;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const a = e.pts[i], b = e.pts[i + 1];
      if (Math.abs(a[0] - b[0]) < 0.4) verts.push({ x: a[0], y1: Math.min(a[1], b[1]), y2: Math.max(a[1], b[1]), e });
    }
  }
  for (const e of model.edges) {
    e.jseg = null;
    if (!e.pts) continue;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const a = e.pts[i], b = e.pts[i + 1];
      if (Math.abs(a[1] - b[1]) >= 0.4) continue;
      const y = a[1], x1 = Math.min(a[0], b[0]) + 3, x2 = Math.max(a[0], b[0]) - 3;
      const hits = verts.filter(v => v.e !== e && v.x > x1 && v.x < x2 && y > v.y1 + 3 && y < v.y2 - 3).map(v => v.x);
      if (hits.length) { if (!e.jseg) e.jseg = new Map(); e.jseg.set(i, hits); }
    }
  }
}

function edgePath(pts, r, jmap, jr) {
  if (pts.length < 2) return '';
  const n = pts.length;
  const cr = k => Math.min(r, dist(pts[k - 1], pts[k]) / 2, dist(pts[k], pts[k + 1]) / 2);
  let d = 'M' + fpt(pts[0]);
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const rOut = i < n - 2 ? cr(i + 1) : 0;
    const segEnd = towards(b, a, rOut);
    if (Math.abs(a[1] - b[1]) < 0.4 && jmap && jmap.get(i)) {
      const dir = Math.sign(b[0] - a[0]) || 1;
      const rIn = i > 0 ? cr(i) : 0;
      const lo = Math.min(a[0], b[0]) + rIn + jr + 2, hi = Math.max(a[0], b[0]) - rOut - jr - 2;
      const hits = jmap.get(i).filter(x => x > lo && x < hi).sort((p, q) => (p - q) * dir);
      const clusters = [];
      for (const x of hits) {
        const c = clusters[clusters.length - 1];
        if (c && Math.abs(x - (dir > 0 ? c.hi : c.lo)) <= jr * 2 + 2) { if (dir > 0) c.hi = x; else c.lo = x; }
        else clusters.push({ lo: x, hi: x });
      }
      for (const c of clusters) {
        const s = (dir > 0 ? c.lo : c.hi) - dir * jr, t = (dir > 0 ? c.hi : c.lo) + dir * jr;
        d += ' L' + fpt([s, a[1]]) + ' A' + r2(Math.abs(t - s) / 2) + ' ' + jr + ' 0 0 ' + (dir > 0 ? 1 : 0) + ' ' + fpt([t, a[1]]);
      }
    }
    d += ' L' + fpt(segEnd);
    if (i < n - 2) d += ' Q' + fpt(b) + ' ' + fpt(towards(b, pts[i + 2], rOut));
  }
  return d;
}
function hexRgba(hex, a) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
function hexLuma(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}
function roundedLeft(x, y, w, h, r) {
  return 'M' + r2(x + w) + ' ' + r2(y) + ' L' + r2(x + r) + ' ' + r2(y) + ' Q' + r2(x) + ' ' + r2(y) + ' ' + r2(x) + ' ' + r2(y + r) +
    ' L' + r2(x) + ' ' + r2(y + h - r) + ' Q' + r2(x) + ' ' + r2(y + h) + ' ' + r2(x + r) + ' ' + r2(y + h) +
    ' L' + r2(x + w) + ' ' + r2(y + h) + ' Z';
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render(model, L, C, ov, jumps) {
  if (jumps === undefined) jumps = true;
  const eKeys = edgeKeysOf(model);
  const S = [];
  S.push('<defs>' +
    '<marker id="arrS" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" fill="#374151"/></marker>' +
    '<marker id="arrD" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" fill="#4b5563"/></marker>' +
    '<filter id="nshadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1" stdDeviation="1.1" flood-color="#0f172a" flood-opacity="0.16"/></filter>' +
    '</defs>');
  if (model.title) S.push('<text x="' + C.margin + '" y="' + (C.margin + 12) + '" font-size="15" font-weight="700" fill="#111827" font-family="' + SANS + '">' + esc(model.title) + '</text>');

  // lanes
  L.lanes.forEach((LB, i) => {
    const lane = model.lanes[i], c = lane.color;
    const x = C.margin, w = L.width - 2 * C.margin, y = LB.y0, h = LB.y1 - LB.y0;
    S.push('<rect x="' + x + '" y="' + r2(y) + '" width="' + r2(w) + '" height="' + r2(h) + '" rx="10" fill="' + hexRgba(c, 0.045) + '" stroke="' + c + '" stroke-width="1.6"/>');
    S.push('<path d="' + roundedLeft(x, y, C.stripW, h, 10) + '" fill="' + c + '"/>');
    const t = lane.title.toUpperCase();
    const maxLen = h - 16, est = t.length * 6.8;
    const tl = est > maxLen ? ' textLength="' + r2(maxLen) + '" lengthAdjust="spacingAndGlyphs"' : '';
    const tfill = hexLuma(c) > 165 ? '#1f2937' : '#fff'; // readable on pastel strips
    S.push('<text transform="translate(' + r2(x + C.stripW / 2 + 3.5) + ',' + r2(y + h / 2) + ') rotate(-90)" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="10" font-weight="700" letter-spacing="1.5" fill="' + tfill + '"' + tl + '>' + esc(t) + '</text>');
  });

  // edges — each in a hoverable group with a wide invisible hit path;
  // dashed edges get a BPMN message-flow source dot so direction reads at a glance
  for (const e of model.edges) {
    if (!e.pts || e.pts.length < 2) continue;
    const dash = e.style === 'dashed';
    const d = (jumps && e.jseg) ? edgePath(e.pts, 6, e.jseg, 4.5) : orthoPath(e.pts, 6);
    const col = dash ? '#4b5563' : '#374151';
    S.push('<g class="edge e' + e.idx + '" data-f="' + esc(e.from) + '" data-t="' + esc(e.to) + '">' +
      '<path class="hit" d="' + orthoPath(e.pts, 6) + '" fill="none" stroke="rgba(0,0,0,0)" stroke-width="13"/>' +
      '<path class="ln" d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.4" ' +
      (dash ? 'stroke-dasharray="5 4" ' : '') + 'marker-end="url(#arr' + (dash ? 'D' : 'S') + ')"/>' +
      '<path class="fl" d="' + d + '" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="5 11" stroke-linecap="round"/>' +
      (dash ? '<circle cx="' + r2(e.pts[0][0]) + '" cy="' + r2(e.pts[0][1]) + '" r="3" fill="#fff" stroke="' + col + '" stroke-width="1.3"/>' : '') +
      '</g>');
  }
  // edge labels (white plate over the line) — placed where they cover neither
  // another edge's segment nor a node
  const allSegs = [];
  for (const e2 of model.edges) if (e2.pts) for (let i = 0; i < e2.pts.length - 1; i++) allSegs.push({ e: e2, a: e2.pts[i], b: e2.pts[i + 1] });
  const nodeBoxes = model.order.map(nn => [nn.sx0 - 2, nn.sy0 - 2, nn.sx1 + 2, nn.sy1 + 2]);
  // node below/above label plates count as occupied space too
  const plates = [];
  for (const n of model.order) {
    if (n.shape === 'rect' || !n.lines.length) continue;
    const above = n.busyBottom && !n.busyTop;
    n.lines.forEach((ln, i) => {
      const w2 = textW(ln, '12px ' + SANS) + 8;
      const y = above ? n.sy0 - 10 - (n.lines.length - 1 - i) * 15 : n.sy1 + 17 + i * 15;
      plates.push([n.cx - w2 / 2, y - 11, n.cx + w2 / 2, y + 3.5]);
    });
  }
  for (const e of model.edges) {
    if (!e.label || !e.pts || e.pts.length < 2) continue;
    const segs = [];
    for (let i = 0; i < e.pts.length - 1; i++) segs.push([e.pts[i], e.pts[i + 1], dist(e.pts[i], e.pts[i + 1])]);
    // candidate segments: solid prefers its first long run, then the longest ones
    const cands = segs.slice().sort((a, b) => b[2] - a[2]).slice(0, 3).filter(s => s[2] > 26);
    if (e.style === 'solid' && segs[0][2] > 50 && !cands.includes(segs[0])) cands.unshift(segs[0]);
    if (!cands.length) cands.push(segs.reduce((a, s) => s[2] > a[2] ? s : a, segs[0]));
    if (e.style === 'solid' && cands.includes(segs[0])) { cands.splice(cands.indexOf(segs[0]), 1); cands.unshift(segs[0]); }
    const w = textW(e.label, '11px ' + SANS) + 10;
    const score = (cx0, cy0) => {
      const rx0 = cx0 - w / 2 - 1, ry0 = cy0 - 9, rx1 = cx0 + w / 2 + 1, ry1 = cy0 + 9;
      let hits = 0;
      for (const s of allSegs) {
        if (s.e === e) continue;
        if (Math.max(s.a[0], s.b[0]) >= rx0 && Math.min(s.a[0], s.b[0]) <= rx1 &&
            Math.max(s.a[1], s.b[1]) >= ry0 && Math.min(s.a[1], s.b[1]) <= ry1) hits++;
      }
      for (const nb of nodeBoxes) if (rx1 >= nb[0] && rx0 <= nb[2] && ry1 >= nb[1] && ry0 <= nb[3]) hits += 3;
      for (const pl of plates) if (rx1 >= pl[0] && rx0 <= pl[2] && ry1 >= pl[1] && ry0 <= pl[3]) hits += 2;
      return hits;
    };
    let best = null, bestHits = Infinity;
    outer:
    for (const seg of cands) {
      for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78, 0.14, 0.86]) {
        const cx0 = seg[0][0] + (seg[1][0] - seg[0][0]) * t, cy0 = seg[0][1] + (seg[1][1] - seg[0][1]) * t;
        const hits = score(cx0, cy0);
        if (hits < bestHits) { bestHits = hits; best = [cx0, cy0]; }
        if (!hits) break outer;
      }
    }
    // parallel-wire fallback: every on-line spot is taken, so sit BESIDE the
    // line instead of on it
    if (bestHits > 0) {
      side:
      for (const seg of cands) {
        const vert = Math.abs(seg[0][0] - seg[1][0]) < 0.4;
        for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
          const cx0 = seg[0][0] + (seg[1][0] - seg[0][0]) * t, cy0 = seg[0][1] + (seg[1][1] - seg[0][1]) * t;
          for (const off of (vert ? [[w / 2 + 5, 0], [-(w / 2 + 5), 0]] : [[0, -14], [0, 14]])) {
            const hits = score(cx0 + off[0], cy0 + off[1]) + 0.5; // slight penalty vs on-line
            if (hits < bestHits) { bestHits = hits; best = [cx0 + off[0], cy0 + off[1]]; }
            if (hits <= 0.5) break side;
          }
        }
      }
    }
    let mx = best[0], my = best[1];
    const lov = ov && ov.labels && ov.labels[eKeys[e.idx]];
    if (lov) { mx += lov.dx || 0; my += lov.dy || 0; }
    plates.push([mx - w / 2 - 1, my - 9, mx + w / 2 + 1, my + 9]);
    S.push('<g class="elabel e' + e.idx + '"><rect x="' + r2(mx - w / 2) + '" y="' + r2(my - 8) + '" width="' + r2(w) + '" height="16" rx="3" fill="#fff" fill-opacity="0.95"/>' +
      '<text x="' + r2(mx) + '" y="' + r2(my + 3.6) + '" text-anchor="middle" font-size="11" fill="#374151" font-family="' + SANS + '">' + esc(e.label) + '</text></g>');
  }

  // nodes
  for (const n of model.order) {
    S.push('<g class="nd" data-id="' + esc(n.id) + '">');
    if (n.shape === 'rect') {
      S.push('<rect x="' + r2(n.sx0) + '" y="' + r2(n.sy0) + '" width="' + r2(n.shapeW) + '" height="' + r2(n.shapeH) + '" rx="8" fill="#fff" stroke="#374151" stroke-width="1.4" filter="url(#nshadow)"/>');
      const lh = 16.5, ty0 = n.cy - (n.lines.length - 1) * lh / 2 + 4;
      n.lines.forEach((ln, i) => S.push('<text x="' + r2(n.cx) + '" y="' + r2(ty0 + i * lh) + '" text-anchor="middle" font-size="12.5" font-weight="500" fill="#111827" font-family="' + SANS + '">' + esc(ln) + '</text>'));
      if (n.icon) {
        const bx = n.sx0 + 7, by = n.sy0 - 13;
        S.push('<rect x="' + r2(bx) + '" y="' + r2(by) + '" width="26" height="26" rx="6.5" fill="#fff" stroke="#374151" stroke-width="1.3"/>');
        S.push(iconSvg(n.icon, bx + 5, by + 5, 16, '#1f2937'));
      }
    } else if (n.shape === 'diamond') {
      const pdef = r2(n.cx) + ',' + r2(n.sy0) + ' ' + r2(n.sx1) + ',' + r2(n.cy) + ' ' + r2(n.cx) + ',' + r2(n.sy1) + ' ' + r2(n.sx0) + ',' + r2(n.cy);
      S.push('<polygon points="' + pdef + '" fill="#fff" stroke="#374151" stroke-width="1.4" filter="url(#nshadow)"/>');
      S.push('<path d="M' + r2(n.cx - 6) + ' ' + r2(n.cy - 6) + 'L' + r2(n.cx + 6) + ' ' + r2(n.cy + 6) + 'M' + r2(n.cx + 6) + ' ' + r2(n.cy - 6) + 'L' + r2(n.cx - 6) + ' ' + r2(n.cy + 6) + '" stroke="#374151" stroke-width="1.8" stroke-linecap="round"/>');
      labelBelow(S, n);
    } else {
      const rr = n.shapeW / 2;
      S.push('<circle cx="' + r2(n.cx) + '" cy="' + r2(n.cy) + '" r="' + rr + '" fill="#fff" stroke="#374151" stroke-width="1.6" filter="url(#nshadow)"/>');
      if (n.icon) S.push(iconSvg(n.icon, n.cx - 13, n.cy - 13, 26, '#1f2937'));
      labelBelow(S, n);
    }
    S.push('</g>');
  }
  return S.join('\n');
}
function labelBelow(S, n) {
  // white plate so edges routed under the label read as passing behind it;
  // when the bottom border is busy with edges and the top is free, the label
  // flips above the shape instead of sitting in the traffic
  const above = n.busyBottom && !n.busyTop;
  n.lines.forEach((ln, i) => {
    const w = textW(ln, '12px ' + SANS) + 8;
    const y = above ? n.sy0 - 10 - (n.lines.length - 1 - i) * 15 : n.sy1 + 17 + i * 15;
    S.push('<rect x="' + r2(n.cx - w / 2) + '" y="' + r2(y - 11) + '" width="' + r2(w) + '" height="14.5" rx="3" fill="#fff" fill-opacity="0.92"/>');
    S.push('<text x="' + r2(n.cx) + '" y="' + r2(y) + '" text-anchor="middle" font-size="12" fill="#111827" font-family="' + SANS + '">' + esc(ln) + '</text>');
  });
}

/* ---------- pipeline ---------- */
function edgeKeysOf(model) {
  const seen = {};
  return model.edges.map(e => {
    const k = e.from + '>' + e.to;
    const key = k + '#' + (seen[k] || 0);
    seen[k] = (seen[k] || 0) + 1;
    return key;
  });
}
function applyNodeOverrides(model, ov) {
  if (!ov || !ov.nodes) return;
  for (const id of Object.keys(ov.nodes)) {
    const n = model.nodes.get(id);
    if (!n) continue;
    const o = ov.nodes[id];
    n.shapeW = Math.max(40, n.shapeW + (o.dw || 0));
    n.shapeH = Math.max(28, n.shapeH + (o.dh || 0));
    n.cx += o.dx || 0; n.cy += o.dy || 0;
    n.sx0 = n.cx - n.shapeW / 2; n.sx1 = n.cx + n.shapeW / 2;
    n.sy0 = n.cy - n.shapeH / 2; n.sy1 = n.cy + n.shapeH / 2;
  }
}
function applySegOverrides(model, ov) {
  if (!ov || !ov.segs) return;
  const keys = edgeKeysOf(model);
  model.edges.forEach((e, idx) => {
    const so = ov.segs[keys[idx]];
    if (!so || !e.pts) return;
    for (const iStr of Object.keys(so)) {
      const i = +iStr, o = so[iStr];
      if (!(i >= 1 && i <= e.pts.length - 3)) continue;
      const a = e.pts[i], b = e.pts[i + 1];
      const vert = Math.abs(a[0] - b[0]) < 0.4, horiz = Math.abs(a[1] - b[1]) < 0.4;
      if (o.a === 'x' && vert) { a[0] += o.d; b[0] += o.d; }
      else if (o.a === 'y' && horiz) { a[1] += o.d; b[1] += o.d; }
    }
  });
}
function applyLocale(model, locale) {
  const dict = locale && model.i18n ? model.i18n[locale] : null;
  if (!dict) return;
  const t = s => (Object.prototype.hasOwnProperty.call(dict, s) ? dict[s] : s);
  model.title = t(model.title);
  model.lanes.forEach(l => { l.title = t(l.title); });
  model.order.forEach(n => { n.label = t(n.label); });
  model.edges.forEach(e => { if (e.label != null) e.label = t(e.label); });
}
function build(src, ov, jumps, locale) {
  if (jumps === undefined) jumps = true;
  const model = parse(src);
  applyLocale(model, locale);
  sizeNodes(model);
  if (!model.lanes.length || !model.order.length) {
    if (model.order.length && !model.lanes.length) model.errors.push('no lanes defined');
    return { model, svg: null };
  }
  ranks(model);
  order(model);
  const L = coords(model, CFG);
  applyNodeOverrides(model, ov);
  route(model, L);
  applySegOverrides(model, ov);
  computeJumps(model);
  return { model, L, svg: render(model, L, CFG, ov, jumps) };
}


/* =====================================================================
   Embeddable widget — mermaid-style: <script src="laneflow.js"> + a
   <pre class="laneflow">DSL</pre> block. Works from file:// (no fetch).
   Edit mode: drag nodes, resize via corner handles, drag edge labels,
   drag interior edge segments. Overrides persist in localStorage and can
   be exported into the DSL as a `%%layout: {...}` line.
   ===================================================================== */
var SVGNS = 'http://www.w3.org/2000/svg';

var LF_CSS = [
  '.lf-widget{position:relative;border:1px solid #e5e7eb;border-radius:10px;background:#eef0f3;overflow:hidden;font:13px ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;min-height:220px;height:100%;box-sizing:border-box}',
  '.lf-tb{display:flex;gap:6px;align-items:center;padding:5px 8px;background:#fff;border-bottom:1px solid #e5e7eb;flex-wrap:wrap}',
  '.lf-tb button{font:inherit;font-size:12px;padding:3px 9px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer}',
  '.lf-tb button:hover{background:#f3f4f6}',
  '.lf-tb label{font-size:12px;color:#4b5563;display:flex;gap:4px;align-items:center}',
  '.lf-tb select.lf-loc{font:inherit;font-size:12px;padding:2px 6px;border:1px solid #d1d5db;border-radius:6px;background:#fff;max-width:110px}',
  '.lf-hint{font-size:11px;color:#9ca3af;margin-left:auto}',
  '.lf-cv{flex:1;position:relative;cursor:grab;min-height:0}',
  '.lf-cv:active{cursor:grabbing}',
  '.lf-cv svg{width:100%;height:100%;display:block}',
  '.lf-cv g.edge,.lf-cv g.elabel,.lf-cv g.nd{transition:opacity .12s}',
  '.lf-cv g.edge .hit{pointer-events:stroke}',
  '.lf-cv svg.hl-mode g.edge:not(.hl),.lf-cv svg.hl-mode g.elabel:not(.hl){opacity:.15}',
  '.lf-cv svg.hl-mode g.nd:not(.hl){opacity:.3}',
  '.lf-cv g.edge.hl .ln{stroke:#1d4ed8;stroke-width:2.1}',
  '.lf-cv g.edge.hl circle{stroke:#1d4ed8}',
  '.lf-cv g.elabel.hl text{fill:#1d4ed8;font-weight:700}',
  '.lf-cv g.edge .fl{display:none;pointer-events:none}',
  '.lf-cv g.edge.hl .fl{display:block;animation:lfflow .8s linear infinite}',
  '@keyframes lfflow{from{stroke-dashoffset:32}to{stroke-dashoffset:0}}',
  '.lf-widget.lf-edit .lf-cv g.nd{cursor:move}',
  '.lf-widget.lf-edit .lf-cv g.elabel{cursor:move}',
  '.lf-widget.lf-edit .lf-cv g.edge .hit{cursor:crosshair}',
  '.lf-sel{fill:none;stroke:#2563eb;stroke-dasharray:4 3;stroke-width:1.2;pointer-events:none}',
  '.lf-h{fill:#fff;stroke:#2563eb;stroke-width:1.2;cursor:nwse-resize}',
  '.lf-guide{stroke:#2563eb;stroke-width:1.6;stroke-dasharray:5 4;pointer-events:none}',
  '.lf-err{position:absolute;left:8px;bottom:8px;right:8px;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:6px;padding:4px 8px;font:11px ui-monospace,Menlo,monospace;max-height:90px;overflow:auto;z-index:3}'
].join('\n');

function ensureStyle() {
  if (document.getElementById('lf-style')) return;
  var st = document.createElement('style');
  st.id = 'lf-style';
  st.textContent = LF_CSS;
  document.head.appendChild(st);
}

function hashDsl(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
function normDsl(s) { return String(s).split(/\r?\n/).filter(function (l) { return !/^\s*%%layout:/.test(l); }).join('\n').trim(); }
function layoutFromDsl(s) {
  var m = String(s).match(/^\s*%%layout:\s*(\{.*\})\s*$/m);
  if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
  return null;
}
function emptyOv() { return { nodes: {}, labels: {}, segs: {} }; }
function copyText(t) {
  var fb = function () {
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(fb);
  else fb();
}
function download(name, blob) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
}

function mount(container, dsl, opts) {
  opts = opts || {};
  ensureStyle();
  container.classList.add('lf-widget');
  container.innerHTML =
    '<div class="lf-tb">' +
    '<button data-a="fit">Fit</button>' +
    '<select class="lf-loc" data-a="locale" style="display:none" title="Language"></select>' +
    '<label><input type="checkbox" data-a="jumps" checked> Jumps</label>' +
    (opts.editable === false ? '' : '<label><input type="checkbox" data-a="edit"> Edit</label>') +
    '<button data-a="svg">SVG</button>' +
    '<button data-a="png">PNG</button>' +
    '<button data-a="copy">Copy DSL</button>' +
    '<button data-a="reset">Reset layout</button>' +
    '<span class="lf-hint"></span>' +
    '</div>' +
    '<div class="lf-cv"><svg xmlns="' + SVGNS + '"><g class="lf-vp"></g></svg></div>';
  var cv = container.querySelector('.lf-cv');
  var svgEl = cv.querySelector('svg');
  var vp = cv.querySelector('.lf-vp');
  var hint = container.querySelector('.lf-hint');
  var state = { dsl: '', lsKey: '', ov: emptyOv(), view: { k: 1, tx: 16, ty: 16 }, edit: false, sel: null, last: null, keys: [], jumps: true, fitted: false, locale: opts.locale || null };
  var drag = null, guideEl = null;

  function persist() { try { localStorage.setItem(state.lsKey, JSON.stringify(state.ov)); } catch (e) {} }
  function applyView() { vp.setAttribute('transform', 'translate(' + state.view.tx + ',' + state.view.ty + ') scale(' + state.view.k + ')'); }
  function toWorld(ev) { var r = cv.getBoundingClientRect(); return [(ev.clientX - r.left - state.view.tx) / state.view.k, (ev.clientY - r.top - state.view.ty) / state.view.k]; }

  function showErrors(errs) {
    var el = container.querySelector('.lf-err');
    if (errs && errs.length) {
      if (!el) { el = document.createElement('div'); el.className = 'lf-err'; container.appendChild(el); }
      el.textContent = errs.join('\n');
    } else if (el) el.remove();
  }

  function syncLocales() {
    var sel = container.querySelector('.lf-loc');
    var locs = state.last && state.last.model && state.last.model.i18n ? Object.keys(state.last.model.i18n) : [];
    if (!locs.length) { sel.style.display = 'none'; return; }
    var want = locs.join('|');
    if (sel.dataset.locs !== want) {
      sel.dataset.locs = want;
      sel.innerHTML = '<option value="">original</option>' + locs.map(function (l) { return '<option value="' + l + '">' + l + '</option>'; }).join('');
    }
    if (state.locale && locs.indexOf(state.locale) < 0) state.locale = null;
    sel.value = state.locale || '';
    sel.style.display = '';
  }
  function rebuild() {
    var b = build(state.dsl, state.ov, state.jumps, state.locale);
    state.last = b;
    try { window.__lf = b; } catch (e) {}
    state.keys = b.model ? edgeKeysOf(b.model) : [];
    vp.innerHTML = b.svg || '';
    drawSel();
    syncLocales();
    showErrors(b.model ? b.model.errors : []);
    if (!state.fitted && b.svg) { state.fitted = true; fit(); }
  }

  function fit() {
    if (!state.last || !state.last.L) return;
    var r = cv.getBoundingClientRect();
    var W = state.last.L.width, H = state.last.L.height;
    var k = Math.min(Math.min(r.width / W, r.height / H) * 0.96, 1.6);
    state.view = { k: k, tx: (r.width - W * k) / 2, ty: (r.height - H * k) / 2 };
    applyView();
  }

  function setDsl(d) {
    state.dsl = normDsl(d);
    state.lsKey = 'laneflow:' + hashDsl(state.dsl);
    var ov = null;
    try { var raw = localStorage.getItem(state.lsKey); if (raw) ov = JSON.parse(raw); } catch (e) {}
    state.ov = ov || layoutFromDsl(d) || emptyOv();
    state.sel = null;
    rebuild();
  }

  function standaloneSvg() {
    var b = state.last;
    return '<svg xmlns="' + SVGNS + '" width="' + b.L.width + '" height="' + b.L.height + '" viewBox="0 0 ' + b.L.width + ' ' + b.L.height + '">' +
      '<rect width="100%" height="100%" fill="#fff"/>' + b.svg + '</svg>';
  }
  function slug() { var t = (state.last && state.last.model && state.last.model.title) || 'laneflow'; return t.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'laneflow'; }

  /* ---- selection overlay & resize ---- */
  function drawSel() {
    vp.querySelectorAll('.lf-selg').forEach(function (x) { x.remove(); });
    if (!state.edit || !state.sel || !state.last || !state.last.model) return;
    var n = state.last.model.nodes.get(state.sel);
    if (!n) return;
    var g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'lf-selg');
    var mk = function (attrs, cls) {
      var el = document.createElementNS(SVGNS, 'rect');
      el.setAttribute('class', cls);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      g.appendChild(el);
    };
    mk({ x: n.sx0 - 5, y: n.sy0 - 5, width: n.shapeW + 10, height: n.shapeH + 10 }, 'lf-sel');
    [['nw', n.sx0 - 5, n.sy0 - 5], ['ne', n.sx1 + 5, n.sy0 - 5], ['se', n.sx1 + 5, n.sy1 + 5], ['sw', n.sx0 - 5, n.sy1 + 5]].forEach(function (h) {
      mk({ 'data-c': h[0], x: h[1] - 4, y: h[2] - 4, width: 8, height: 8 }, 'lf-h');
    });
    vp.appendChild(g);
  }
  function resizeDelta(d) {
    var px = d.px || 0, py = d.py || 0;
    var sx = (d.corner === 'nw' || d.corner === 'sw') ? -1 : 1;
    var sy = (d.corner === 'nw' || d.corner === 'ne') ? -1 : 1;
    return { dw: px * sx, dh: py * sy, dx: px / 2, dy: py / 2 };
  }
  function liveResize(d) {
    var g = vp.querySelector('.lf-selg');
    if (!g || !state.sel) return;
    var n = state.last.model.nodes.get(state.sel);
    var r = resizeDelta(d);
    var w = Math.max(40, n.shapeW + r.dw), h = Math.max(28, n.shapeH + r.dh);
    var cx = n.cx + r.dx, cy = n.cy + r.dy;
    var rect = g.querySelector('.lf-sel');
    rect.setAttribute('x', cx - w / 2 - 5); rect.setAttribute('y', cy - h / 2 - 5);
    rect.setAttribute('width', w + 10); rect.setAttribute('height', h + 10);
  }

  /* ---- segment picking & guide ---- */
  function pickSeg(idx, w) {
    var e = state.last && state.last.model && state.last.model.edges[idx];
    if (!e || !e.pts || e.pts.length < 4) return null;
    var best = null, bd = 12 / state.view.k + 4;
    for (var i = 1; i <= e.pts.length - 3; i++) {
      var a = e.pts[i], b = e.pts[i + 1];
      var vert = Math.abs(a[0] - b[0]) < 0.4;
      var d;
      if (vert) { var y1 = Math.min(a[1], b[1]) - 4, y2 = Math.max(a[1], b[1]) + 4; d = (w[1] >= y1 && w[1] <= y2) ? Math.abs(w[0] - a[0]) : 1e9; }
      else { var x1 = Math.min(a[0], b[0]) - 4, x2 = Math.max(a[0], b[0]) + 4; d = (w[0] >= x1 && w[0] <= x2) ? Math.abs(w[1] - a[1]) : 1e9; }
      if (d < bd) { bd = d; best = { i: i, axis: vert ? 'x' : 'y', a: [a[0], a[1]], b: [b[0], b[1]] }; }
    }
    return best;
  }
  function mkGuide(d) {
    guideEl = document.createElementNS(SVGNS, 'line');
    guideEl.setAttribute('class', 'lf-guide');
    moveGuide(d);
    vp.appendChild(guideEl);
  }
  function moveGuide(d) {
    if (!guideEl) return;
    var ax = d.axis === 'x' ? (d.d || 0) : 0, ay = d.axis === 'y' ? (d.d || 0) : 0;
    guideEl.setAttribute('x1', d.a[0] + ax); guideEl.setAttribute('y1', d.a[1] + ay);
    guideEl.setAttribute('x2', d.b[0] + ax); guideEl.setAttribute('y2', d.b[1] + ay);
  }
  function rmGuide() { if (guideEl) guideEl.remove(); guideEl = null; }

  /* ---- hover-to-trace ---- */
  function clearHl() {
    svgEl.classList.remove('hl-mode');
    vp.querySelectorAll('.hl').forEach(function (el) { el.classList.remove('hl'); });
  }
  function applyHl(idxs, ids) {
    if (!idxs.length && !ids.length) return;
    svgEl.classList.add('hl-mode');
    idxs.forEach(function (i) { vp.querySelectorAll('.e' + i).forEach(function (el) { el.classList.add('hl'); }); });
    ids.forEach(function (id) {
      var el = vp.querySelector('g.nd[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (el) el.classList.add('hl');
    });
  }
  function hover(ev) {
    var t = ev.target;
    var ge = t.closest ? t.closest('g.edge') : null;
    var gn = !ge && t.closest ? t.closest('g.nd') : null;
    clearHl();
    if (ge) {
      var cls = Array.prototype.find.call(ge.classList, function (c) { return /^e\d+$/.test(c); });
      if (cls) applyHl([+cls.slice(1)], [ge.dataset.f, ge.dataset.t].filter(Boolean));
    } else if (gn) {
      var id = gn.dataset.id, idxs = [], nids = { };
      nids[id] = 1;
      vp.querySelectorAll('g.edge').forEach(function (el) {
        if (el.dataset.f === id || el.dataset.t === id) {
          var c2 = Array.prototype.find.call(el.classList, function (c) { return /^e\d+$/.test(c); });
          if (c2) idxs.push(+c2.slice(1));
          nids[el.dataset.f] = 1; nids[el.dataset.t] = 1;
        }
      });
      applyHl(idxs, Object.keys(nids));
    }
  }

  /* ---- pointer interactions ---- */
  cv.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var f = Math.exp(-ev.deltaY * 0.0016), r = cv.getBoundingClientRect();
    var mx = ev.clientX - r.left, my = ev.clientY - r.top;
    state.view.tx = mx - (mx - state.view.tx) * f;
    state.view.ty = my - (my - state.view.ty) * f;
    state.view.k *= f;
    applyView();
  }, { passive: false });

  cv.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return;
    var t = ev.target;
    if (state.edit) {
      var h = t.closest && t.closest('.lf-h');
      var nd = t.closest && t.closest('g.nd');
      var lb = t.closest && t.closest('g.elabel');
      var eg = t.closest && t.closest('g.edge');
      if (h) { drag = { type: 'resize', corner: h.dataset.c, sx: ev.clientX, sy: ev.clientY, px: 0, py: 0 }; cv.setPointerCapture(ev.pointerId); return; }
      if (nd) { drag = { type: 'node', id: nd.dataset.id, el: nd, sx: ev.clientX, sy: ev.clientY, mx: 0, my: 0 }; cv.setPointerCapture(ev.pointerId); return; }
      if (lb) {
        var cls = Array.prototype.find.call(lb.classList, function (c) { return /^e\d+$/.test(c); });
        if (cls) { drag = { type: 'label', idx: +cls.slice(1), el: lb, sx: ev.clientX, sy: ev.clientY, mx: 0, my: 0 }; cv.setPointerCapture(ev.pointerId); return; }
      }
      if (eg) {
        var cls2 = Array.prototype.find.call(eg.classList, function (c) { return /^e\d+$/.test(c); });
        if (cls2) {
          var pick = pickSeg(+cls2.slice(1), toWorld(ev));
          if (pick) {
            drag = { type: 'seg', idx: +cls2.slice(1), sx: ev.clientX, sy: ev.clientY, d: 0, i: pick.i, axis: pick.axis, a: pick.a, b: pick.b };
            mkGuide(drag); cv.setPointerCapture(ev.pointerId); return;
          }
        }
      }
    }
    drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, tx: state.view.tx, ty: state.view.ty };
    cv.setPointerCapture(ev.pointerId);
  });

  cv.addEventListener('pointermove', function (ev) {
    if (!drag) { hover(ev); return; }
    var ddx = ev.clientX - drag.sx, ddy = ev.clientY - drag.sy;
    if (drag.type === 'pan') { state.view.tx = drag.tx + ddx; state.view.ty = drag.ty + ddy; applyView(); }
    else if (drag.type === 'node' || drag.type === 'label') {
      drag.mx = ddx / state.view.k; drag.my = ddy / state.view.k;
      drag.el.setAttribute('transform', 'translate(' + drag.mx + ',' + drag.my + ')');
    } else if (drag.type === 'resize') { drag.px = ddx / state.view.k; drag.py = ddy / state.view.k; liveResize(drag); }
    else if (drag.type === 'seg') { drag.d = (drag.axis === 'x' ? ddx : ddy) / state.view.k; moveGuide(drag); }
  });

  cv.addEventListener('pointerup', function (ev) {
    if (!drag) return;
    var d = drag; drag = null;
    if (d.type === 'pan') {
      if (state.edit && Math.abs(ev.clientX - d.sx) < 3 && Math.abs(ev.clientY - d.sy) < 3) { state.sel = null; drawSel(); }
      return;
    }
    if (d.type === 'node') {
      if (Math.abs(d.mx) < 3 && Math.abs(d.my) < 3) { d.el.removeAttribute('transform'); state.sel = d.id; drawSel(); return; }
      var o = state.ov.nodes[d.id] = state.ov.nodes[d.id] || { dx: 0, dy: 0, dw: 0, dh: 0 };
      o.dx += d.mx; o.dy += d.my; persist(); rebuild();
    } else if (d.type === 'label') {
      if (Math.abs(d.mx) < 2 && Math.abs(d.my) < 2) { d.el.removeAttribute('transform'); return; }
      var key = state.keys[d.idx];
      var lo = state.ov.labels[key] = state.ov.labels[key] || { dx: 0, dy: 0 };
      lo.dx += d.mx; lo.dy += d.my; persist(); rebuild();
    } else if (d.type === 'resize') {
      if (!state.sel) return;
      var r = resizeDelta(d);
      var no = state.ov.nodes[state.sel] = state.ov.nodes[state.sel] || { dx: 0, dy: 0, dw: 0, dh: 0 };
      no.dw += r.dw; no.dh += r.dh; no.dx += r.dx; no.dy += r.dy; persist(); rebuild();
    } else if (d.type === 'seg') {
      rmGuide();
      if (Math.abs(d.d) >= 2) {
        var k2 = state.keys[d.idx];
        var so = state.ov.segs[k2] = state.ov.segs[k2] || {};
        var cur = so[d.i] || { a: d.axis, d: 0 };
        cur.a = d.axis; cur.d += d.d; so[d.i] = cur; persist(); rebuild();
      }
    }
  });
  cv.addEventListener('pointerleave', function () { if (!drag) clearHl(); });

  /* ---- toolbar ---- */
  container.querySelector('.lf-tb').addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button') : null;
    if (!b) return;
    var a = b.dataset.a;
    if (a === 'fit') fit();
    else if (a === 'svg') { if (state.last && state.last.svg) download(slug() + '.svg', new Blob([standaloneSvg()], { type: 'image/svg+xml' })); }
    else if (a === 'png') {
      if (!state.last || !state.last.svg) return;
      var img = new Image();
      var url = URL.createObjectURL(new Blob([standaloneSvg()], { type: 'image/svg+xml' }));
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = state.last.L.width * 2; c.height = state.last.L.height * 2;
        var ctx = c.getContext('2d');
        ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        c.toBlob(function (bl) { download(slug() + '.png', bl); }, 'image/png');
      };
      img.src = url;
    }
    else if (a === 'copy') copyText(state.dsl + '\n%%layout: ' + JSON.stringify(state.ov));
    else if (a === 'reset') {
      try { localStorage.removeItem(state.lsKey); } catch (e) {}
      state.ov = emptyOv();
      state.sel = null;
      rebuild();
    }
  });
  container.querySelector('.lf-tb').addEventListener('change', function (ev) {
    var a = ev.target.dataset && ev.target.dataset.a;
    if (a === 'jumps') { state.jumps = ev.target.checked; rebuild(); }
    else if (a === 'locale') { state.locale = ev.target.value || null; rebuild(); }
    else if (a === 'edit') {
      state.edit = ev.target.checked;
      container.classList.toggle('lf-edit', state.edit);
      hint.textContent = state.edit ? 'kéo node / label / đoạn edge — click node để resize' : '';
      if (!state.edit) { state.sel = null; }
      clearHl(); drawSel();
    }
  });

  var api = {
    setDsl: setDsl,
    setLocale: function (loc) { state.locale = loc || null; rebuild(); },
    fit: fit,
    rebuild: rebuild,
    last: function () { return state.last; },
    getOverrides: function () { return state.ov; },
    el: container,
  };
  container.__laneflow = api;
  if (dsl) setDsl(dsl);
  return api;
}

function init(root) {
  var els = (root || document).querySelectorAll('pre.laneflow, div.laneflow, script[type="text/laneflow"]');
  Array.prototype.forEach.call(els, function (el) {
    if (el.__lfDone) return;
    el.__lfDone = true;
    var dsl = (el.textContent || '').trim();
    var holder = document.createElement('div');
    holder.style.height = el.getAttribute('data-height') || '460px';
    el.parentNode.replaceChild(holder, el);
    mount(holder, dsl, { editable: el.getAttribute('data-edit') !== 'false', locale: el.getAttribute('data-locale') || null });
  });
}

/* ---------- public API ---------- */
var API = {
  version: '1.1.0',
  init: init,
  mount: mount,
  build: build,
  parse: parse,
  render: function (dsl, ov, jumps, locale) { var b = build(dsl, ov, jumps, locale); return b.svg || ''; },
};
global.LaneFlow = API;
global.laneflow = { parse: parse, build: build, render: API.render };
if (!global.LaneFlowNoAutoInit && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(); });
  else setTimeout(function () { init(); }, 0);
}

})(typeof window !== 'undefined' ? window : this);
