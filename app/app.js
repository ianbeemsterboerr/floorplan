/* Khaaka — a tiny, dependency-free 2D layout-map editor.
   Coordinate system: world units = meters. Rendering scales by `pxPerMeter` * zoom. */

(() => {
  'use strict';

  // Build tag — check this in the browser console to confirm which script
  // the page actually loaded. Bump it alongside the ?v= in index.html.
  const BUILD = 6;

  // One app, two modes. Served from a real host it is a read-only viewer;
  // run locally it is the full editor. ?mode=edit / ?mode=view forces either.
  // Nothing in view mode can reach a path that mutates the layout.
  const MODE = (() => {
    const forced = new URLSearchParams(location.search).get('mode');
    if (forced === 'edit' || forced === 'view') return forced;
    const h = location.hostname;
    const local = !h || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local');
    return local ? 'edit' : 'view';
  })();
  const READONLY = MODE === 'view';
  document.body.classList.toggle('view-mode', READONLY);
  console.info(`Khaaka build ${BUILD} — hover a wall, door, window or ruler to measure it`);

  // ---------- State ----------
  // Each open tab owns its own state object. The module-level `state` is a
  // reference to the active tab's state, swapped in switchToTab(). Code that
  // reads/writes `state.X` continues to work — it just always points at the
  // active tab.
  function makeBlankState() {
    return {
      objects: [],        // all shapes in z-order
      selectedId: null,   // primary selection (last added) — used by props panel
      selectedIds: new Set(), // multi-selection set; selectedId is its "leader"
      tool: 'select',
      nextId: 1,
      view: { x: 0, y: 0, zoom: 1 }, // pan in screen px, zoom multiplier
      pxPerMeter: 40,
      pxPerBox: 25,        // screen pixels per grid box (drives pxPerMeter)
      grid: { show: true, snap: true, size: 0.3048 }, // 1 ft default
      showDims: true,
      units: 'ft', // 'm' = meters, 'ft' = feet & inches, 'mm' = millimeters
      defaultWallThickness: 0.1524, // 6" in meters
      projectName: 'Untitled Layout',
      history: [],
      future: [],
    };
  }
  let state = makeBlankState();

  const M_PER_FT = 0.3048;

  // Legacy single-tab key (still read once at startup for migration).
  const STORAGE_KEY = 'plotly.layout.v1';
  // Multi-tab keys
  const TABS_KEY = 'khaaka.tabs.v1';            // [{ id, name, snapJSON, fileName }]
  const ACTIVE_TAB_KEY = 'khaaka.tabs.active.v1';

  // ---------- DOM ----------
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const hint = document.getElementById('hint');
  const statusMsg = document.getElementById('status-msg');
  const layerList = document.getElementById('layer-list');

  // ---------- Limited color palettes (light shades only) ----------
  const FILL_SWATCHES = [
    '#ffffff', '#fff8e6', '#fde9ef', '#fce5d8', '#f3e9d2',
    '#e7f7ec', '#e0f2fe', '#e8f0ff', '#efe8ff', '#eef1f6',
  ];
  // Highlight for a hovered ruler and the wall it measures.
  const HOVER_RED = '#d61f3f';

  // Services. All share one object type so they group together in the Layers
  // panel; `kind` picks the symbol. Drawn at a fixed screen size, the way
  // symbols work on a real plan — they mark a position, not an area.
  const FIXTURES = {
    socket: { label: 'Socket',       color: '#b45309' },
    switch: { label: 'Switch',       color: '#b45309' },
    light:  { label: 'Light point',  color: '#b45309' },
    gas:    { label: 'Gas point',    color: '#a16207' },
    water:  { label: 'Water supply', color: '#0369a1' },
    drain:  { label: 'Drain',        color: '#475569' },
  };
  const FIXTURE_R = 9;   // symbol radius in screen px

  // Notes: a numbered pin whose text appears on hover, so a long remark can
  // live on the plan without printing across it.
  const NOTE_COLOR = '#7c3aed';
  const NOTE_R = 10;

  // A note's media is a plain list of URLs or repo-relative paths. The kind
  // is inferred rather than declared, so authoring one is just a paste.
  function mediaKind(src) {
    const u = String(src).trim();
    if (/^https?:\/\/(www\.)?instagram\.com\/(reel|reels|p|tv)\//i.test(u)) return 'instagram';
    if (/\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i.test(u)) return 'image';
    if (/^https?:\/\//i.test(u)) return 'link';
    return 'image';                      // a bare path is taken to be a picture
  }

  // Instagram's oEmbed needs an app token these days, but the /embed page
  // does not, and it renders the poster frame — which is the preview we want.
  function instagramEmbed(url) {
    const m = String(url).match(/instagram\.com\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
    if (!m) return null;
    const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
    return `https://www.instagram.com/${kind}/${m[2]}/embed/captioned/`;
  }

  const STROKE_SWATCHES = [
    '#cbd5e1', '#94a3b8', '#7da3e8', '#7ec295', '#e88b9f',
    '#a48de0', '#c8a05a', '#1f3a8a', '#a3b8d8', '#d4b896',
  ];

  // ---------- Helpers ----------
  const uid = () => state.nextId++;

  const screenToWorld = (sx, sy) => {
    const s = state.pxPerMeter * state.view.zoom;
    return { x: (sx - state.view.x) / s, y: (sy - state.view.y) / s };
  };
  const worldToScreen = (wx, wy) => {
    const s = state.pxPerMeter * state.view.zoom;
    return { x: wx * s + state.view.x, y: wy * s + state.view.y };
  };

  const snap = (v) => {
    if (!state.grid.snap) return v;
    const g = state.grid.size;
    return Math.round(v / g) * g;
  };

  const fmt = (n) => (Math.round(n * 100) / 100).toString();

  // Unit conversion + formatting
  const mToFt = (m) => m / M_PER_FT;
  const ftToM = (f) => f * M_PER_FT;

  // Convert between meters and the active display unit.
  const unitToM = (v) => (state.units === 'ft' ? ftToM(v) : state.units === 'mm' ? v / 1000 : v);
  const mToUnit = (m) => (state.units === 'ft' ? mToFt(m) : state.units === 'mm' ? m * 1000 : m);

  // Format meters according to current unit choice.
  // Meters: "3.25 m". Millimeters: "3250 mm". Feet/inches: `12'-3"`
  // (rounded to nearest 1/2 inch by default)
  function fmtLen(meters) {
    if (state.units === 'ft') return fmtFeetInches(meters);
    if (state.units === 'mm') return `${Math.round(meters * 1000)} mm`;
    return `${fmt(meters)} m`;
  }

  function fmtFeetInches(meters) {
    const totalInches = mToFt(meters) * 12;
    // Round to nearest 1/2 inch for display
    const half = Math.round(totalInches * 2) / 2;
    let ft = Math.trunc(half / 12);
    let inches = half - ft * 12;
    if (inches < 0) { inches += 12; ft -= 1; }
    // Roll over: e.g. 11.99" -> 12" -> +1 ft
    if (inches >= 12) { ft += 1; inches -= 12; }
    const inStr = (inches % 1 === 0) ? `${inches}"` : `${inches.toFixed(1)}"`;
    return `${ft}'-${inStr}`;
  }

  // Format an area (m²) in the active units.
  // Imperial: "96 sq ft" (rounded to nearest 1 sq ft, or 1 decimal under 1 sq ft).
  // Metric:   "8.92 m²" (2 decimals up to 100 m², then 1 decimal).
  // Millimeter mode also reports areas in m² — mm² figures are unreadable.
  function fmtArea(m2) {
    if (state.units === 'ft') {
      const sqft = m2 / (M_PER_FT * M_PER_FT);
      const v = sqft >= 1 ? Math.round(sqft) : Math.round(sqft * 10) / 10;
      return `${v.toLocaleString()} sq ft`;
    }
    const v = m2 < 100 ? Math.round(m2 * 100) / 100 : Math.round(m2 * 10) / 10;
    return `${v} m\u00b2`;
  }

  // Intersection area of two axis-aligned rectangles (0 if disjoint).
  function rectIntersectArea(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const w = x2 - x, h = y2 - y;
    return (w > 0 && h > 0) ? w * h : 0;
  }

  // Visible area of a room: its own rectangle minus any portions covered by
  // rooms drawn ON TOP of it (later in state.objects = higher z-order).
  // This matches what the user sees: the perimeter at the click point.
  // Sum of every room's net area = union area (no double counting).
  function roomNetArea(room) {
    let area = (room.w || 0) * (room.h || 0);
    const idx = state.objects.indexOf(room);
    for (let i = idx + 1; i < state.objects.length; i++) {
      const o = state.objects[i];
      if (o.type !== 'room') continue;
      area -= rectIntersectArea(room, o);
    }
    return Math.max(0, area);
  }

  // Smart selection area for an arbitrary set of rooms.
  // Same z-order model as roomNetArea but restricted to the selection so the
  // user only counts what they explicitly picked.
  function computeSelectionArea(rooms) {
    if (!rooms || rooms.length === 0) return { area: 0, lines: [] };
    const sorted = [...rooms].sort(
      (a, b) => state.objects.indexOf(a) - state.objects.indexOf(b)
    );
    const lines = [];
    let total = 0;
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      let area = (r.w || 0) * (r.h || 0);
      for (let j = i + 1; j < sorted.length; j++) {
        area -= rectIntersectArea(r, sorted[j]);
      }
      area = Math.max(0, area);
      total += area;
      lines.push({ label: r.label || 'Room', area });
    }
    return { area: total, lines };
  }

  // Format meters as a value suitable for an editable input field.
  // Meters: numeric like "3.25". Feet/inches: a string like `12'-3"`.
  function fmtLenInput(meters) {
    if (state.units === 'ft') return fmtFeetInches(meters);
    if (state.units === 'mm') return fmt(meters * 1000);
    return fmt(meters);
  }

  // Parse a length string into meters. Accepts:
  //   - bare number: meters, millimeters or feet depending on current units
  //   - `12'`, `12'3"`, `12'-3"`, `12 ft 3 in`, `3 in`, `36"`
  //   - `1.5m`, `150cm`, `1500mm`
  function parseLen(str) {
    if (str == null) return null;
    const s = String(str).trim().toLowerCase();
    if (s === '') return null;

    // Explicit metric suffix
    let m = s.match(/^(-?\d*\.?\d+)\s*(mm|cm|m)$/);
    if (m) {
      const v = parseFloat(m[1]);
      if (m[2] === 'mm') return v / 1000;
      if (m[2] === 'cm') return v / 100;
      return v;
    }

    // Feet / inches forms
    // e.g. 12'3", 12'-3", 12', 3", 12ft 3in, 12 ft 3 in, 12 feet 3 inches
    const ftInRe = /^(?:(-?\d*\.?\d+)\s*(?:'|ft|feet|foot))?\s*[-\s]?\s*(?:(-?\d*\.?\d+)\s*(?:"|in|inch|inches))?$/;
    const fi = s.match(ftInRe);
    if (fi && (fi[1] || fi[2])) {
      const ft = parseFloat(fi[1] || '0') || 0;
      const inches = parseFloat(fi[2] || '0') || 0;
      return ftToM(ft + inches / 12);
    }

    // Bare number: interpret per current units
    const num = parseFloat(s);
    if (!isNaN(num)) {
      return unitToM(num);
    }
    return null;
  }

  const historySnapshot = () =>
    JSON.stringify({ objects: state.objects, nextId: state.nextId });

  // Push a snapshot captured earlier. Used by the typed length fields, which
  // preview live but must record only the pre-edit state, once.
  function pushHistorySnapshot(snap) {
    state.history.push(snap);
    if (state.history.length > 100) state.history.shift();
    state.future.length = 0;
  }
  function pushHistory() { pushHistorySnapshot(historySnapshot()); }
  function undo() {
    if (state.history.length === 0) return;
    state.future.push(JSON.stringify({ objects: state.objects, nextId: state.nextId }));
    const snap = JSON.parse(state.history.pop());
    state.objects = snap.objects;
    state.nextId = snap.nextId;
    state.selectedId = null;
    refreshAll();
  }
  function redo() {
    if (state.future.length === 0) return;
    state.history.push(JSON.stringify({ objects: state.objects, nextId: state.nextId }));
    const snap = JSON.parse(state.future.pop());
    state.objects = snap.objects;
    state.nextId = snap.nextId;
    state.selectedId = null;
    refreshAll();
  }

  // ---------- Object factories ----------
  function makeObject(type, props) {
    const base = {
      id: uid(),
      type,
      label: '',
      fill: '#e8f0ff',
      stroke: '#1f3a8a',
      strokeWidth: 2,
    };
    return Object.assign(base, props);
  }

  // Object types:
  // - room:    {x, y, w, h}
  // - polygon: {points: [{x,y}, ...], closed}
  // - wall:    {x1, y1, x2, y2, thickness}
  // - door:    {x, y, w, rot}
  // - window:  {x, y, w, rot}
  // - text:    {x, y, text, size}

  function getBounds(o) {
    switch (o.type) {
      case 'room':
        return { x: o.x, y: o.y, w: o.w, h: o.h };
      case 'polygon': {
        const pts = o.points || [];
        if (pts.length === 0) return { x: 0, y: 0, w: 0.1, h: 0.1 };
        let xMin = pts[0].x, xMax = pts[0].x, yMin = pts[0].y, yMax = pts[0].y;
        for (const p of pts) {
          if (p.x < xMin) xMin = p.x;
          if (p.x > xMax) xMax = p.x;
          if (p.y < yMin) yMin = p.y;
          if (p.y > yMax) yMax = p.y;
        }
        return { x: xMin, y: yMin, w: Math.max(0.1, xMax - xMin), h: Math.max(0.1, yMax - yMin) };
      }
      case 'wall':
      case 'measure': {
        const x = Math.min(o.x1, o.x2), y = Math.min(o.y1, o.y2);
        return { x, y, w: Math.abs(o.x2 - o.x1) || 0.1, h: Math.abs(o.y2 - o.y1) || 0.1 };
      }
      case 'ruler': {
        // The clickable body is the offset dimension line, not the wall.
        const L = rulerLine(o);
        if (!L) return { x: o.x1, y: o.y1, w: 0.1, h: 0.1 };
        const x = Math.min(L.ax, L.bx), y = Math.min(L.ay, L.by);
        return { x, y, w: Math.abs(L.bx - L.ax) || 0.1, h: Math.abs(L.by - L.ay) || 0.1 };
      }
      case 'door':
      case 'window': {
        // Rotation-aware AABB around the opening's two endpoints.
        const rad = (o.rot || 0) * Math.PI / 180;
        const ex = o.x + Math.cos(rad) * o.w;
        const ey = o.y + Math.sin(rad) * o.w;
        const x = Math.min(o.x, ex);
        const y = Math.min(o.y, ey);
        const pad = 0.1; // small padding so the halo doesn't sit on the line
        return {
          x: x - pad,
          y: y - pad,
          w: Math.max(0.1, Math.abs(ex - o.x)) + pad * 2,
          h: Math.max(0.1, Math.abs(ey - o.y)) + pad * 2,
        };
      }
      case 'fixture':
      case 'note': {
        // Screen-sized symbol, so its footprint in world units follows zoom.
        const pin = o.type === 'note' ? NOTE_R : FIXTURE_R;
        const r = (pin + 2) / (state.pxPerMeter * state.view.zoom);
        return { x: o.x - r, y: o.y - r, w: r * 2, h: r * 2 };
      }
      case 'text':
        return { x: o.x, y: o.y - 0.3, w: Math.max(1, o.text.length * 0.2), h: 0.4 };
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  function setBounds(o, b) {
    switch (o.type) {
      case 'room':
        o.x = b.x; o.y = b.y; o.w = Math.max(0.1, b.w); o.h = Math.max(0.1, b.h); break;
      case 'polygon': {
        // Translate every vertex so the bbox top-left lands at b.x,b.y.
        const cur = getBounds(o);
        const dx = b.x - cur.x;
        const dy = b.y - cur.y;
        if (dx || dy) for (const p of o.points) { p.x += dx; p.y += dy; }
        break;
      }
      case 'wall':
      case 'measure': {
        const dx = b.x - Math.min(o.x1, o.x2);
        const dy = b.y - Math.min(o.y1, o.y2);
        o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
        break;
      }
      case 'door':
      case 'window': {
        // Translate the opening so its AABB top-left matches the requested b.x,b.y
        const cur = getBounds(o);
        const dx = b.x - cur.x;
        const dy = b.y - cur.y;
        o.x += dx; o.y += dy;
        if (typeof b.w === 'number' && b.w > 0) o.w = Math.max(0.3, b.w);
        break;
      }
      case 'fixture':
      case 'note': {
        const cur = getBounds(o);
        o.x += b.x - cur.x; o.y += b.y - cur.y;
        break;
      }
      case 'text':
        o.x = b.x; o.y = b.y + 0.3; break;
    }
  }

  // A ruler annotates one wall: it stores the wall's id, a signed
  // perpendicular offset, and a cached copy of the span it measures. The
  // cache is refreshed from the wall on every draw; if the wall is deleted
  // the ruler stays put at its last known geometry rather than vanishing.
  function syncRulers() {
    for (const o of state.objects) {
      if (o.type !== 'ruler' || o.wallId == null) continue;
      const wall = state.objects.find(x => x.id === o.wallId && x.type === 'wall');
      if (!wall) continue;
      o.x1 = wall.x1; o.y1 = wall.y1; o.x2 = wall.x2; o.y2 = wall.y2;
    }
  }

  // Unit normal of a ruler's span, and its two offset endpoints — the line
  // the dimension is actually drawn on.
  function rulerLine(o) {
    const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const nx = -dy / len, ny = dx / len;
    const off = o.offset || 0;
    return {
      len, nx, ny,
      ax: o.x1 + nx * off, ay: o.y1 + ny * off,
      bx: o.x2 + nx * off, by: o.y2 + ny * off,
    };
  }

  // Where a new ruler goes: far enough along the wall's normal to clear every
  // room, on the side facing away from the plan — the drafting convention of
  // dimensioning outside the drawing rather than across it. Rulers already
  // parked at that distance get stepped past so they don't stack up.
  function defaultRulerOffset(wall) {
    const margin = 44 / (state.pxPerMeter * state.view.zoom);
    const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return margin;
    const nx = -dy / len, ny = dx / len;
    const rooms = state.objects
      .filter(o => o.type === 'room' || o.type === 'polygon')
      .map(getBounds)
      .filter(b => b && b.w > 0);
    if (!rooms.length) return -margin;

    const cx = rooms.reduce((a, b) => a + b.x + b.w / 2, 0) / rooms.length;
    const cy = rooms.reduce((a, b) => a + b.y + b.h / 2, 0) / rooms.length;
    const mx = (wall.x1 + wall.x2) / 2, my = (wall.y1 + wall.y2) / 2;
    const sign = ((mx - cx) * nx + (my - cy) * ny) >= 0 ? 1 : -1;

    // Furthest any room corner reaches along that direction.
    let reach = 0;
    for (const b of rooms) {
      for (const c of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) {
        reach = Math.max(reach, ((c[0] - mx) * nx + (c[1] - my) * ny) * sign);
      }
    }
    let dist = reach + margin;

    // Step past any parallel ruler whose dimension line already sits there.
    // Compared by where the line lands, not by offset: two walls at different
    // depths can share a line despite having different offsets.
    const parallel = [];
    for (const o of state.objects) {
      if (o.type !== 'ruler') continue;
      const ol = rulerLine(o);
      if (!ol || Math.abs(ol.nx * nx + ol.ny * ny) < 0.99) continue;
      parallel.push(ol.ax * nx + ol.ay * ny);
    }
    for (let guard = 0; guard < 40; guard++) {
      const proj = (mx + nx * sign * dist) * nx + (my + ny * sign * dist) * ny;
      if (!parallel.some(pp => Math.abs(pp - proj) < margin * 0.9)) break;
      dist += margin;
    }
    return sign * dist;
  }

  // Length of a wall / measure segment, in meters.
  const segmentLength = (o) => Math.hypot(o.x2 - o.x1, o.y2 - o.y1);

  // Resize a wall / measure segment to an exact length, keeping its start
  // point and angle. A degenerate (zero-length) segment extends along +x.
  function setSegmentLength(o, meters) {
    const m = Math.max(0.01, meters);
    const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) { o.x2 = o.x1 + m; o.y2 = o.y1; return; }
    const k = m / len;
    o.x2 = o.x1 + dx * k;
    o.y2 = o.y1 + dy * k;
  }

  // While shift-dragging a wall, look for a translation that lands one of its
  // two endpoints exactly on another wall's endpoint. Returns the adjusted
  // delta and the point being snapped to, or null when nothing is in range.
  // Only the delta changes, so the wall keeps its angle and length.
  function findWallEndSnap(wall, orig, delta) {
    const tol = 14 / (state.pxPerMeter * state.view.zoom);
    const moving = [
      { x: orig.x1 + delta.x, y: orig.y1 + delta.y },
      { x: orig.x2 + delta.x, y: orig.y2 + delta.y },
    ];
    let best = null;
    for (const other of state.objects) {
      if (other.id === wall.id || other.type !== 'wall' || other.hidden) continue;
      for (const t of [{ x: other.x1, y: other.y1 }, { x: other.x2, y: other.y2 }]) {
        for (const m of moving) {
          const d = Math.hypot(t.x - m.x, t.y - m.y);
          if (d > tol || (best && d >= best.dist)) continue;
          best = {
            dist: d,
            point: t,
            dx: delta.x + (t.x - m.x),
            dy: delta.y + (t.y - m.y),
          };
        }
      }
    }
    return best;
  }

  // Perpendicular distance from a point to a segment.
  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  // Ruler under the pointer, hit on its dimension line rather than its
  // bounding box so a long ruler doesn't swallow everything beside it.
  function hitRuler(wx, wy) {
    const tol = 9 / (state.pxPerMeter * state.view.zoom);
    const p = worldToScreen(wx, wy);
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (o.type !== 'ruler' || o.hidden) continue;
      // The label pill first: it is the biggest target and the one people
      // actually point at.
      const r = o._rulerLabel;
      if (r) {
        const cos = Math.cos(-r.angle), sin = Math.sin(-r.angle);
        const lx = (p.x - r.cx) * cos - (p.y - r.cy) * sin;
        const ly = (p.x - r.cx) * sin + (p.y - r.cy) * cos;
        if (Math.abs(lx) <= r.halfW + 2 && Math.abs(ly) <= r.halfH + 2) return o;
      }
      const L = rulerLine(o);
      if (L && distToSegment(wx, wy, L.ax, L.ay, L.bx, L.by) <= tol) return o;
    }
    return null;
  }

  // A wall is drawn highlighted when the hovered ruler measures it.
  const hoveredRulerWallId = () =>
    (hover && hover.kind === 'ruler') ? hover.wallId : null;

  // The stretch of a wall the pointer is on, cut short by any door or window
  // sitting on that wall. This is what makes every piece measurable: the bit
  // between two openings reports its own length, not the whole wall's.
  function wallPieceAt(wall, wx, wy) {
    const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const ux = dx / len, uy = dy / len;
    const along = (px, py) => (px - wall.x1) * ux + (py - wall.y1) * uy;
    const across = (px, py) => Math.abs((px - wall.x1) * -uy + (py - wall.y1) * ux);
    const tolPerp = (wall.thickness || state.defaultWallThickness) / 2
      + 8 / (state.pxPerMeter * state.view.zoom);

    // Everything that interrupts this wall, as [from, to] spans.
    const cuts = [];

    // Openings sitting along it.
    for (const o of state.objects) {
      if (o.type !== 'door' && o.type !== 'window') continue;
      const rad = (o.rot || 0) * Math.PI / 180;
      const ex = o.x + Math.cos(rad) * o.w, ey = o.y + Math.sin(rad) * o.w;
      if (across(o.x, o.y) > tolPerp || across(ex, ey) > tolPerp) continue;
      let a = along(o.x, o.y), b = along(ex, ey);
      if (a > b) { const t = a; a = b; b = t; }
      if (b <= 0 || a >= len) continue;
      cuts.push([Math.max(0, a), Math.min(len, b)]);
    }

    // Other walls meeting or crossing it. A piece runs to the *face* of the
    // crossing wall, so what you read is the clear span, the same way an
    // opening is measured.
    for (const o of state.objects) {
      if (o.type !== 'wall' || o === wall || o.hidden) continue;
      const ox = o.x2 - o.x1, oy = o.y2 - o.y1;
      const olen = Math.hypot(ox, oy);
      if (olen < 1e-9) continue;
      const denom = ux * oy - uy * ox;
      if (Math.abs(denom) < 1e-9) continue;                 // parallel
      // Intersection of the two centrelines, as distances along each.
      const t = ((o.x1 - wall.x1) * oy - (o.y1 - wall.y1) * ox) / denom;
      const u = ((o.x1 - wall.x1) * uy - (o.y1 - wall.y1) * ux) / denom;
      if (u < -1e-6 || u > olen + 1e-6) continue;           // misses the other wall
      if (t < 0 || t > len) continue;
      // Widen the cut to the crossing wall's faces, allowing for the angle.
      const sinA = Math.abs(denom) / olen;
      const halfSpan = ((o.thickness || state.defaultWallThickness) / 2) / Math.max(0.2, sinA);
      cuts.push([Math.max(0, t - halfSpan), Math.min(len, t + halfSpan)]);
    }

    cuts.sort((p, q) => p[0] - q[0]);

    const piece = (a, b) => (b - a < 1e-6) ? null : {
      x1: wall.x1 + ux * a, y1: wall.y1 + uy * a,
      x2: wall.x1 + ux * b, y2: wall.y1 + uy * b,
      len: b - a,
      thickness: wall.thickness || state.defaultWallThickness,
    };

    const tp = Math.max(0, Math.min(len, along(wx, wy)));
    let start = 0;
    for (const [a, b] of cuts) {
      if (tp < a) return piece(start, a);
      if (tp <= b) return null;          // pointer is on the opening itself
      start = Math.max(start, b);
    }
    return piece(start, len);
  }

  // Whatever is under the pointer, and how long it is.
  function computeHover(wx, wy, sx, sy) {
    const tol = 7 / (state.pxPerMeter * state.view.zoom);

    // Notes come first: the pin is small and deliberately placed, so it
    // should win over whatever it sits on.
    const noteR = (NOTE_R + 3) / (state.pxPerMeter * state.view.zoom);
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (o.type !== 'note' || o.hidden) continue;
      if (Math.hypot(wx - o.x, wy - o.y) > noteR) continue;
      return { kind: 'note', id: o.id, sx, sy,
               text: o.text || '', lines: wrapNote(o.text || '(empty note)') };
    }

    // Services are points, not spans, so hovering one names it instead of
    // reporting a length.
    const fxR = (FIXTURE_R + 3) / (state.pxPerMeter * state.view.zoom);
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (o.type !== 'fixture' || o.hidden) continue;
      if (Math.hypot(wx - o.x, wy - o.y) > fxR) continue;
      const meta = FIXTURES[o.kind] || {};
      return { kind: 'fixture', id: o.id, sx, sy,
               text: o.label ? `${meta.label} · ${o.label}` : (meta.label || o.kind) };
    }

    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (o.hidden) continue;
      if (o.type === 'door' || o.type === 'window') {
        const rad = (o.rot || 0) * Math.PI / 180;
        const ex = o.x + Math.cos(rad) * o.w, ey = o.y + Math.sin(rad) * o.w;
        if (distToSegment(wx, wy, o.x, o.y, ex, ey) <= tol) {
          return {
            kind: o.type, id: o.id, text: fmtLen(o.w), sx, sy,
            seg: { x1: o.x, y1: o.y, x2: ex, y2: ey, thickness: 0 },
          };
        }
      } else if (o.type === 'measure') {
        if (distToSegment(wx, wy, o.x1, o.y1, o.x2, o.y2) <= tol) {
          const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
          return {
            kind: 'measure', id: o.id, text: fmtLen(len), sx, sy,
            seg: { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, thickness: 0 },
          };
        }
      }
    }

    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (o.type !== 'wall' || o.hidden) continue;
      const half = (o.thickness || state.defaultWallThickness) / 2;
      if (distToSegment(wx, wy, o.x1, o.y1, o.x2, o.y2) > half + tol) continue;
      const piece = wallPieceAt(o, wx, wy);
      if (piece) return { kind: 'wall', id: o.id, text: fmtLen(piece.len), seg: piece, sx, sy };
    }

    // Rulers last. Zoomed out their labels sprawl across the outer walls, and
    // when the pointer is genuinely on a wall that is what you meant.
    const r = hitRuler(wx, wy);
    if (r) {
      const L = rulerLine(r);
      return { kind: 'ruler', id: r.id, wallId: r.wallId, text: fmtLen(L ? L.len : 0), sx, sy };
    }
    return null;
  }

  // The highlighted piece plus its length, pinned beside the pointer.
  function drawHoverReadout() {
    if (!hover) return;
    ctx.save();
    if (hover.seg) {
      const a = worldToScreen(hover.seg.x1, hover.seg.y1);
      const b = worldToScreen(hover.seg.x2, hover.seg.y2);
      // Dashed for a measure line: it annotates a span, and drawing it as a
      // solid bar makes empty space look like fabric that is not there.
      if (hover.kind === 'measure') ctx.setLineDash([6, 4]);
      const s = state.pxPerMeter * state.view.zoom;
      ctx.strokeStyle = HOVER_RED;
      ctx.lineWidth = Math.max(3, (hover.seg.thickness || 0) * s);
      ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    const r = canvas.getBoundingClientRect();

    // A note carries prose, so it gets a panel rather than a one-line pill.
    if (hover.lines) {
      ctx.font = '500 12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const lh = 16, padX = 9, padY = 7;
      const w = Math.max(...hover.lines.map(l => ctx.measureText(l).width));
      const boxW = w + padX * 2, boxH = hover.lines.length * lh + padY * 2;
      let x = hover.sx + 16, y = hover.sy + 14;
      if (x + boxW > r.width) x = Math.max(4, hover.sx - 16 - boxW);
      if (y + boxH > r.height) y = Math.max(4, hover.sy - 14 - boxH);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = NOTE_COLOR;
      ctx.lineWidth = 1.5;
      roundRect(ctx, x, y, boxW, boxH, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#1c2433';
      hover.lines.forEach((line, i) => ctx.fillText(line, x + padX, y + padY + i * lh));
      ctx.restore();
      return;
    }

    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(hover.text).width;
    const padX = 6, padY = 3, h = 14;
    let x = hover.sx + 16, y = hover.sy - 16;
    if (x + w + padX * 2 > r.width) x = hover.sx - 16 - w - padX * 2;
    if (y - h / 2 - padY < 0) y = hover.sy + 20;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = HOVER_RED;
    ctx.lineWidth = 1.5;
    roundRect(ctx, x - padX, y - h / 2 - padY, w + padX * 2, h + padY * 2, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = HOVER_RED;
    ctx.fillText(hover.text, x, y);
    ctx.restore();
  }

  function hitTest(wx, wy) {
    // top-most first
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      // Polygons: precise point-in-polygon (closed only) so users can't
      // grab the shape through holes outside its body.
      if (o.type === 'polygon' && o.closed && (o.points || []).length >= 3) {
        if (pointInPolygon(wx, wy, o.points)) return o;
        continue;
      }
      const b = getBounds(o);
      const pad = 0.15; // meters tolerance for thin objects
      if (wx >= b.x - pad && wx <= b.x + b.w + pad &&
          wy >= b.y - pad && wy <= b.y + b.h + pad) {
        return o;
      }
    }
    return null;
  }

  // Standard ray-casting point-in-polygon test.
  function pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ---------- Selection helpers (multi-select) ----------
  // selectedIds is a Set; selectedId mirrors the most recently added member
  // so the existing properties panel keeps working unchanged.
  function ensureSelection() {
    if (!state.selectedIds || !(state.selectedIds instanceof Set)) {
      state.selectedIds = new Set();
    }
  }
  function setSelection(ids) {
    ensureSelection();
    state.selectedIds = new Set(ids || []);
    state.selectedId = state.selectedIds.size
      ? [...state.selectedIds][state.selectedIds.size - 1]
      : null;
  }
  function addToSelection(id) {
    ensureSelection();
    state.selectedIds.add(id);
    state.selectedId = id;
  }
  function removeFromSelection(id) {
    ensureSelection();
    state.selectedIds.delete(id);
    if (state.selectedId === id) {
      state.selectedId = state.selectedIds.size
        ? [...state.selectedIds][state.selectedIds.size - 1]
        : null;
    }
  }
  function toggleSelection(id) {
    ensureSelection();
    if (state.selectedIds.has(id)) removeFromSelection(id);
    else addToSelection(id);
  }
  function clearSelection() {
    ensureSelection();
    state.selectedIds.clear();
    state.selectedId = null;
  }
  function selectAll() {
    setSelection(state.objects.map(o => o.id));
    refreshAll();
  }
  function getSelectedObjects() {
    ensureSelection();
    return state.objects.filter(o => state.selectedIds.has(o.id));
  }

  // ---------- Clipboard (cross-tab) ----------
  // Lives at module scope so switching tabs preserves it. Mirrored to
  // localStorage so paste works after a reload too.
  let clipboard = [];
  const CLIPBOARD_KEY = 'khaaka.clipboard.v1';
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    if (raw) clipboard = JSON.parse(raw) || [];
  } catch { /* ignore */ }
  function setClipboard(objs) {
    clipboard = (objs || []).map(o => JSON.parse(JSON.stringify(o)));
    try { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clipboard)); } catch {}
  }
  function copySelection() {
    const sel = getSelectedObjects();
    if (sel.length === 0) { flash('Nothing selected'); return; }
    setClipboard(sel);
    flash(`Copied ${sel.length} item${sel.length === 1 ? '' : 's'}`);
  }
  function cutSelection() {
    const sel = getSelectedObjects().filter(o => !o.locked);
    if (sel.length === 0) { flash('Nothing to cut'); return; }
    setClipboard(sel);
    pushHistory();
    const cutIds = new Set(sel.map(o => o.id));
    state.objects = state.objects.filter(o => !cutIds.has(o.id));
    clearSelection();
    refreshAll();
    flash(`Cut ${sel.length} item${sel.length === 1 ? '' : 's'}`);
  }
  // Translate every coordinate-bearing field on an object by (dx, dy).
  function translateObject(o, dx, dy) {
    if (o.type === 'wall' || o.type === 'measure') {
      o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
    } else if (typeof o.x === 'number' && typeof o.y === 'number') {
      o.x += dx; o.y += dy;
    }
  }
  function pasteClipboard() {
    if (!clipboard || clipboard.length === 0) { flash('Clipboard is empty'); return; }
    pushHistory();
    const offset = state.grid.size; // one grid box, units-aware
    const newIds = [];
    for (const src of clipboard) {
      const o = JSON.parse(JSON.stringify(src));
      o.id = uid();
      translateObject(o, offset, offset);
      state.objects.push(o);
      newIds.push(o.id);
    }
    setSelection(newIds);
    refreshAll();
    flash(`Pasted ${newIds.length} item${newIds.length === 1 ? '' : 's'}`);
  }
  function duplicateSelection() {
    const sel = getSelectedObjects();
    if (sel.length === 0) { flash('Nothing selected'); return; }
    pushHistory();
    const offset = state.grid.size;
    const newIds = [];
    for (const src of sel) {
      const o = JSON.parse(JSON.stringify(src));
      o.id = uid();
      translateObject(o, offset, offset);
      state.objects.push(o);
      newIds.push(o.id);
    }
    setSelection(newIds);
    refreshAll();
    flash(`Duplicated ${newIds.length} item${newIds.length === 1 ? '' : 's'}`);
  }

  // ---------- Rendering ----------
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.floor(r.width * dpr);
    canvas.height = Math.floor(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    syncRulers();
    const r = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);

    // Background paper — soft cool off-white with a faint vertical gradient
    const grad = ctx.createLinearGradient(0, 0, 0, r.height);
    grad.addColorStop(0, '#f7f8fb');
    grad.addColorStop(1, '#eef1f6');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, r.width, r.height);

    drawGrid(r);

    // Objects: two passes so dimension labels never get covered by other shapes
    for (const o of state.objects) {
      if (o.type !== 'ruler') drawObject(o);
    }
    if (state.showDims) {
      for (const o of state.objects) drawObjectDimensions(o);
    }
    // Rulers last, whatever their z-order. They are annotations about the
    // drawing rather than part of it, so a wall or a room added after one
    // must not bury its label.
    for (const o of state.objects) {
      if (o.type === 'ruler') drawObject(o);
    }
    drawHoverReadout();

    // Selection halos — every member of the multi-selection.
    ensureSelection();
    if (state.selectedIds.size > 0) {
      const onlyOne = state.selectedIds.size === 1;
      for (const o of state.objects) {
        if (state.selectedIds.has(o.id)) drawSelection(o, onlyOne);
      }
    }

    // Marquee rectangle (drawn on top of objects + halos)
    if (drag && drag.mode === 'marquee') {
      const a = worldToScreen(drag.startWorld.x, drag.startWorld.y);
      const b = worldToScreen(drag.endWorld.x, drag.endWorld.y);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      ctx.save();
      ctx.fillStyle = 'rgba(74, 118, 245, 0.10)';
      ctx.strokeStyle = 'rgba(74, 118, 245, 0.85)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    // Snap target while shift-dragging a wall onto another wall's endpoint.
    // Drawn last, and opaque, so it reads clearly over the wall and the
    // selection handle that sit underneath it.
    if (wallSnapHint) {
      const sp = worldToScreen(wallSnapHint.x, wallSnapHint.y);
      ctx.save();
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(74, 118, 245, 0.95)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(74, 118, 245, 0.95)';
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Polygon draft preview: rubber-band line + closing-vertex halo
    if (drag && drag.mode === 'polygon-draft' && drag.obj) {
      const pts = drag.obj.points || [];
      if (pts.length > 0 && drag.hover) {
        const last = worldToScreen(pts[pts.length - 1].x, pts[pts.length - 1].y);
        const cur  = worldToScreen(drag.hover.x, drag.hover.y);
        ctx.save();
        ctx.strokeStyle = 'rgba(74, 118, 245, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(cur.x, cur.y); ctx.stroke();
        // Closing hint when hovering near the first vertex
        if (pts.length >= 3) {
          const first = pts[0];
          const tol = 10 / (state.pxPerMeter * state.view.zoom);
          if (Math.hypot(first.x - drag.hover.x, first.y - drag.hover.y) < tol) {
            const fp = worldToScreen(first.x, first.y);
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(74, 118, 245, 0.30)';
            ctx.beginPath(); ctx.arc(fp.x, fp.y, 7, 0, Math.PI * 2); ctx.fill();
          }
        }
        ctx.restore();
      }
      // Vertex dots
      ctx.save();
      ctx.fillStyle = '#5b8cff';
      for (const p of pts) {
        const sp = worldToScreen(p.x, p.y);
        ctx.fillRect(sp.x - 3, sp.y - 3, 6, 6);
      }
      ctx.restore();
    }

    positionNoteCard();
    updateStatus();
  }

  function drawGrid(r) {
    if (!state.grid.show) return;
    const s = state.pxPerMeter * state.view.zoom;
    const step = state.grid.size * s;
    if (step < 6) return; // too dense

    const ox = state.view.x % step;
    const oy = state.view.y % step;

    ctx.strokeStyle = '#e3e7ef';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ox; x < r.width; x += step) {
      ctx.moveTo(x, 0); ctx.lineTo(x, r.height);
    }
    for (let y = oy; y < r.height; y += step) {
      ctx.moveTo(0, y); ctx.lineTo(r.width, y);
    }
    ctx.stroke();

    // Major grid every 5 cells
    const major = step * 5;
    const ox2 = state.view.x % major;
    const oy2 = state.view.y % major;
    ctx.strokeStyle = '#c7cfdd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ox2; x < r.width; x += major) { ctx.moveTo(x, 0); ctx.lineTo(x, r.height); }
    for (let y = oy2; y < r.height; y += major) { ctx.moveTo(0, y); ctx.lineTo(r.width, y); }
    ctx.stroke();

    // Origin axes
    const o = worldToScreen(0, 0);
    ctx.strokeStyle = '#9aa5ba';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(o.x, 0); ctx.lineTo(o.x, r.height);
    ctx.moveTo(0, o.y); ctx.lineTo(r.width, o.y);
    ctx.stroke();
  }

  function drawObject(o) {
    const s = state.pxPerMeter * state.view.zoom;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (o.type === 'room') {
      const p = worldToScreen(o.x, o.y);
      ctx.fillStyle = o.fill;
      ctx.strokeStyle = o.stroke;
      ctx.lineWidth = o.strokeWidth;
      ctx.fillRect(p.x, p.y, o.w * s, o.h * s);
      ctx.strokeRect(p.x, p.y, o.w * s, o.h * s);

      const cx = p.x + (o.w * s) / 2;
      const cy = p.y + (o.h * s) / 2;
      if (o.label) {
        ctx.fillStyle = '#1c2433';
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(o.label, cx, cy);
      }
      // Per-room area label (opt-in via right-click). Position is stored as
      // fractional offset (0..1) inside the room so it follows on move/resize.
      if (o.showArea) {
        // Net area = own rectangle minus overlapping rooms drawn on top of
        // it. Matches "perimeter visible at click point" intuition.
        const text = fmtArea(roomNetArea(o));
        const fx = (o.areaPos && typeof o.areaPos.fx === 'number') ? o.areaPos.fx : 0.5;
        const fy = (o.areaPos && typeof o.areaPos.fy === 'number') ? o.areaPos.fy : (o.label ? 0.66 : 0.5);
        const lx = p.x + fx * o.w * s;
        const ly = p.y + fy * o.h * s;
        ctx.fillStyle = '#475569';
        ctx.font = '500 11px "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, lx, ly);
        // Stash hit rect (screen space) for the mouse handler.
        const m = ctx.measureText(text);
        const halfW = m.width / 2 + 4;
        const halfH = 8;
        o._areaRect = { cx: lx, cy: ly, halfW, halfH };
      } else {
        o._areaRect = null;
      }
    } else if (o.type === 'polygon') {
      const pts = o.points || [];
      if (pts.length < 2) {
        // While drafting (single vertex) just draw a small dot.
        if (pts.length === 1) {
          const p = worldToScreen(pts[0].x, pts[0].y);
          ctx.fillStyle = o.stroke || '#1f3a8a';
          ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        ctx.beginPath();
        const first = worldToScreen(pts[0].x, pts[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < pts.length; i++) {
          const sp = worldToScreen(pts[i].x, pts[i].y);
          ctx.lineTo(sp.x, sp.y);
        }
        // Closed: fill + closing line. Open (still drafting): stroke only.
        if (o.closed) {
          ctx.closePath();
          ctx.fillStyle = o.fill || '#e8f0ff';
          ctx.fill();
        }
        ctx.strokeStyle = o.stroke || '#1f3a8a';
        ctx.lineWidth = o.strokeWidth || 2;
        ctx.stroke();
        // Optional label at centroid
        const c = (o.closed && (o.label || o.showArea)) ? polygonCentroid(pts) : null;
        if (o.closed && o.label) {
          const sp = worldToScreen(c.x, c.y);
          ctx.fillStyle = '#1c2433';
          ctx.font = '600 13px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(o.label, sp.x, sp.y);
        }
        // Per-polygon area label (opt-in via right-click).
        // Position is stored in absolute world coords so it stays put under
        // vertex reshapes; defaults to centroid when first turned on.
        if (o.closed && o.showArea) {
          const text = fmtArea(polygonArea(pts));
          const ax = (o.areaPos && typeof o.areaPos.x === 'number') ? o.areaPos.x : c.x;
          const ay = (o.areaPos && typeof o.areaPos.y === 'number') ? o.areaPos.y
            : (o.label ? c.y + 0.25 : c.y);
          const sp = worldToScreen(ax, ay);
          ctx.fillStyle = '#475569';
          ctx.font = '500 11px "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, sp.x, sp.y);
          const m = ctx.measureText(text);
          o._areaRect = { cx: sp.x, cy: sp.y, halfW: m.width / 2 + 4, halfH: 8 };
        } else {
          o._areaRect = null;
        }
      }
    } else if (o.type === 'wall') {
      const a = worldToScreen(o.x1, o.y1);
      const b = worldToScreen(o.x2, o.y2);
      ctx.strokeStyle = (o.id === hoveredRulerWallId())
        ? HOVER_RED
        : (o.stroke || '#4a2e1c');
      ctx.lineWidth = (o.thickness || state.defaultWallThickness) * s;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (o.type === 'door') {
      const p = worldToScreen(o.x, o.y);
      const w = o.w * s;
      ctx.translate(p.x, p.y);
      ctx.rotate((o.rot || 0) * Math.PI / 180);
      ctx.strokeStyle = o.stroke || '#874f0e';
      ctx.lineWidth = 2;
      // Opening line (single)
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(w, 0);
      ctx.stroke();
      // Door swing arc
      ctx.beginPath();
      ctx.arc(0, 0, w, 0, -Math.PI / 2, true);
      ctx.stroke();
      // Door panel
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(0, -w);
      ctx.stroke();
    } else if (o.type === 'window') {
      const p = worldToScreen(o.x, o.y);
      const w = o.w * s;
      ctx.translate(p.x, p.y);
      ctx.rotate((o.rot || 0) * Math.PI / 180);
      ctx.fillStyle = '#cfe6ff';
      ctx.strokeStyle = o.stroke || '#1f3a8a';
      ctx.lineWidth = 2;
      ctx.fillRect(0, -4, w, 8);
      ctx.strokeRect(0, -4, w, 8);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.stroke();
    } else if (o.type === 'note') {
      drawNotePin(o);
    } else if (o.type === 'fixture') {
      drawFixtureSymbol(o);
    } else if (o.type === 'text') {
      const p = worldToScreen(o.x, o.y);
      ctx.fillStyle = o.fill || '#1c2433';
      ctx.font = `${(o.size || 14)}px system-ui, sans-serif`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(o.text || 'Text', p.x, p.y);
    } else if (o.type === 'measure') {
      const a = worldToScreen(o.x1, o.y1);
      const b = worldToScreen(o.x2, o.y2);
      const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      ctx.strokeStyle = '#64748b';
      ctx.fillStyle = '#475569';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(fmtLen(len), (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 6);
    } else if (o.type === 'ruler') {
      // Offset dimension: witness lines out from the wall's ends, then the
      // dimension line itself with ticks and a length pill. Drawn clear of
      // the wall so the plan underneath stays readable.
      const L = rulerLine(o);
      if (L) {
        const hot = !!hover && hover.kind === 'ruler' && hover.id === o.id;
        const a0 = worldToScreen(o.x1, o.y1), b0 = worldToScreen(o.x2, o.y2);
        const a1 = worldToScreen(L.ax, L.ay), b1 = worldToScreen(L.bx, L.by);
        ctx.strokeStyle = hot ? HOVER_RED : (o.stroke || '#8a93a6');
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (const [p0, p1] of [[a0, a1], [b0, b1]]) {
          const vx = p1.x - p0.x, vy = p1.y - p0.y;
          const d = Math.hypot(vx, vy);
          if (d < 8) continue;                       // too close to bother
          const ux = vx / d, uy = vy / d;
          const GAP = 4, OVER = 6;                   // px clear of wall / past line
          ctx.moveTo(p0.x + ux * GAP, p0.y + uy * GAP);
          ctx.lineTo(p0.x + ux * (d + OVER), p0.y + uy * (d + OVER));
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        const text = o.label ? `${o.label}  ${fmtLen(L.len)}` : fmtLen(L.len);
        o._rulerLabel = drawDimension(L.ax, L.ay, L.bx, L.by, text, false, 0, hot ? HOVER_RED : null);
        return;
      }
    }

    ctx.restore();
  }

  // Second pass — draw dimension labels for an object so they sit above all
  // body fills/strokes and never get hidden by overlapping rooms.
  function drawObjectDimensions(o) {
    const s = state.pxPerMeter * state.view.zoom;
    if (o.type === 'room') {
      drawDimension(o.x, o.y - 0.2, o.x + o.w, o.y - 0.2, fmtLen(o.w));
      drawDimension(o.x - 0.2, o.y, o.x - 0.2, o.y + o.h, fmtLen(o.h), true);
    } else if (o.type === 'wall') {
      const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      const t = (o.thickness || state.defaultWallThickness) * s;
      // dimSide: 0 = default side, 1 = flipped to the other side of the wall
      const sign = (o.dimSide === 1 || o.dimSide === -1) ? -1 : 1;
      o._dimLabel = drawDimension(o.x1, o.y1, o.x2, o.y2, fmtLen(len), false, (t / 2 + 12) * sign);
    } else if (o.type === 'door' || o.type === 'window') {
      // Cycle through 4 label positions around the door's right angle:
      //   0: parallel to opening, side A (default)
      //   1: parallel to panel,   side A
      //   2: parallel to opening, side B
      //   3: parallel to panel,   side B
      const w = o.w;
      const rotDeg = o.rot || 0;
      const side = doorDimSide(o);
      const armRotDeg = (side === 0 || side === 2) ? rotDeg : rotDeg - 90;
      const perpSign = (side === 0 || side === 1) ? 1 : -1;
      const rad = armRotDeg * Math.PI / 180;
      const ex = o.x + Math.cos(rad) * w;
      const ey = o.y + Math.sin(rad) * w;
      o._dimLabel = drawDimension(o.x, o.y, ex, ey, fmtLen(w), false, 14 * perpSign);
    }
  }

  // Normalize door/window dimSide to 0..3, mapping legacy +1/-1 values.
  function doorDimSide(o) {
    const raw = o.dimSide;
    if (raw === undefined || raw === null) return 0;
    if (raw === 1) return 0;
    if (raw === -1) return 2;
    return ((Math.round(raw) % 4) + 4) % 4;
  }

  // The service symbols. Sized in screen pixels so they stay legible at any
  // zoom, and rotated by `rot` so a socket can face into its wall.
  function drawFixtureSymbol(o) {
    const meta = FIXTURES[o.kind] || FIXTURES.socket;
    const p = worldToScreen(o.x, o.y);
    const R = FIXTURE_R;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((o.rot || 0) * Math.PI / 180);
    ctx.strokeStyle = o.stroke || meta.color;
    ctx.fillStyle = o.stroke || meta.color;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (o.kind === 'socket') {
      // IEC socket outlet: half disc sitting on a stem.
      ctx.beginPath(); ctx.arc(0, 0, R, Math.PI, 0); ctx.closePath();
      ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-R, 0); ctx.lineTo(R, 0);
      ctx.moveTo(0, 0); ctx.lineTo(0, R + 4); ctx.stroke();
    } else if (o.kind === 'switch') {
      // Lever switch: pivot dot with an arm.
      ctx.beginPath(); ctx.arc(0, R * 0.6, 2.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, R * 0.6); ctx.lineTo(R * 0.95, -R * 0.75);
      ctx.moveTo(R * 0.35, -R * 0.95); ctx.lineTo(R * 1.05, -R * 0.55);
      ctx.stroke();
    } else if (o.kind === 'light') {
      // Lamp: circle crossed through.
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
      const d = R * 0.707;
      ctx.beginPath();
      ctx.moveTo(-d, -d); ctx.lineTo(d, d);
      ctx.moveTo(d, -d); ctx.lineTo(-d, d);
      ctx.stroke();
    } else if (o.kind === 'gas') {
      // Hexagon marked G.
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + i * Math.PI / 3;
        const x = Math.cos(a) * R, y = Math.sin(a) * R;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.stroke();
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('G', 0, 0.5);
    } else if (o.kind === 'water') {
      // Droplet.
      ctx.beginPath();
      ctx.moveTo(0, -R);
      ctx.bezierCurveTo(R * 1.05, -R * 0.1, R * 0.8, R, 0, R);
      ctx.bezierCurveTo(-R * 0.8, R, -R * 1.05, -R * 0.1, 0, -R);
      ctx.closePath();
      ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
    } else if (o.kind === 'drain') {
      // Circle with flow going down into it.
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.6); ctx.lineTo(0, R * 0.45);
      ctx.moveTo(-R * 0.45, -R * 0.05); ctx.lineTo(0, R * 0.5);
      ctx.lineTo(R * 0.45, -R * 0.05);
      ctx.stroke();
    }
    ctx.restore();

    if (o.label) {
      ctx.save();
      ctx.fillStyle = '#475569';
      ctx.font = '500 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(o.label, p.x, p.y + R + 6);
      ctx.restore();
    }
  }

  // Notes are numbered in the order they were added.
  const noteNumber = (o) =>
    state.objects.filter(x => x.type === 'note').indexOf(o) + 1;

  function drawNotePin(o) {
    const p = worldToScreen(o.x, o.y);
    ctx.save();
    ctx.beginPath(); ctx.arc(p.x, p.y, NOTE_R, 0, Math.PI * 2);
    ctx.fillStyle = NOTE_COLOR;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(noteNumber(o)), p.x, p.y + 0.5);
    ctx.restore();
  }

  // Break a note into short lines for the hover panel.
  function wrapNote(text, max = 38) {
    const out = [];
    for (const para of String(text).split(/\n/)) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        if (!line.length) { line = word; continue; }
        if ((line + ' ' + word).length > max) { out.push(line); line = word; }
        else line += ' ' + word;
      }
      out.push(line);
    }
    return out.filter(l => l.length);
  }

  // ---------- Note card ----------
  // Hovering a note shows its text on the canvas; clicking one opens this,
  // which is real DOM so it can hold pictures and embeds.

  const noteCard = document.getElementById('note-card');
  const noteCardNum = document.getElementById('note-num');
  const noteCardText = document.getElementById('note-text');
  const noteCardMedia = document.getElementById('note-media');
  let openNoteId = null;

  function closeNoteCard() {
    if (openNoteId === null) return;
    openNoteId = null;
    if (noteCard) { noteCard.hidden = true; noteCardMedia.innerHTML = ''; }
  }

  function openNoteCard(o) {
    if (!noteCard) return;
    openNoteId = o.id;
    noteCardNum.textContent = String(noteNumber(o));
    noteCardText.textContent = o.text || '';
    noteCardMedia.innerHTML = '';

    for (const src of (o.media || [])) {
      const kind = mediaKind(src);
      if (kind === 'image') {
        const fig = document.createElement('figure');
        const img = document.createElement('img');
        img.src = src;
        img.loading = 'lazy';
        img.alt = o.text || 'Note image';
        img.addEventListener('error', () => {
          fig.innerHTML = '';
          const warn = document.createElement('p');
          warn.className = 'note-fail';
          warn.textContent = `Could not load ${src}`;
          fig.appendChild(warn);
        });
        fig.appendChild(img);
        noteCardMedia.appendChild(fig);
      } else if (kind === 'instagram') {
        const frame = document.createElement('iframe');
        frame.className = 'note-embed';
        frame.src = instagramEmbed(src);
        frame.loading = 'lazy';
        frame.allowFullscreen = true;
        frame.referrerPolicy = 'no-referrer-when-downgrade';
        frame.title = 'Instagram';
        noteCardMedia.appendChild(frame);
        const a = document.createElement('a');
        a.className = 'note-link';
        a.href = src; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = 'Open on Instagram';
        noteCardMedia.appendChild(a);
      } else {
        const a = document.createElement('a');
        a.className = 'note-link';
        a.href = src; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = src;
        noteCardMedia.appendChild(a);
      }
    }
    noteCard.hidden = false;
    positionNoteCard();
  }

  // Keep the card beside its pin as the plan is panned or zoomed.
  function positionNoteCard() {
    if (openNoteId === null || !noteCard) return;
    const o = state.objects.find(x => x.id === openNoteId);
    if (!o) { closeNoteCard(); return; }
    const wrap = noteCard.parentElement.getBoundingClientRect();
    const p = worldToScreen(o.x, o.y);
    const w = noteCard.offsetWidth || 300;
    const h = noteCard.offsetHeight || 200;
    let x = p.x + NOTE_R + 10;
    let y = p.y - 10;
    if (x + w > wrap.width - 8) x = Math.max(8, p.x - NOTE_R - 10 - w);
    if (y + h > wrap.height - 8) y = Math.max(8, wrap.height - 8 - h);
    noteCard.style.left = `${Math.round(x)}px`;
    noteCard.style.top = `${Math.round(y)}px`;
  }

  if (noteCard) {
    document.getElementById('note-close').addEventListener('click', closeNoteCard);
    // Clicks inside the card belong to the card, not the canvas underneath.
    noteCard.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  function drawDimension(x1, y1, x2, y2, label, vertical = false, perpOffset = 0, color = null) {
    const a = worldToScreen(x1, y1);
    const b = worldToScreen(x2, y2);
    ctx.save();
    ctx.strokeStyle = color || '#5b6478';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    // tick marks
    const tick = 5;
    ctx.beginPath();
    if (vertical) {
      ctx.moveTo(a.x - tick, a.y); ctx.lineTo(a.x + tick, a.y);
      ctx.moveTo(b.x - tick, b.y); ctx.lineTo(b.x + tick, b.y);
    } else {
      ctx.moveTo(a.x, a.y - tick); ctx.lineTo(a.x, a.y + tick);
      ctx.moveTo(b.x, b.y - tick); ctx.lineTo(b.x, b.y + tick);
    }
    ctx.stroke();

    // Label with background pill, rotated for vertical/diagonal lines
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 8) { ctx.restore(); return null; } // too short to label clearly

    let angle = Math.atan2(dy, dx);
    // Keep text upright (avoid upside-down)
    let flipped = false;
    if (angle > Math.PI / 2)  { angle -= Math.PI; flipped = true; }
    if (angle < -Math.PI / 2) { angle += Math.PI; flipped = true; }

    let cx = (a.x + b.x) / 2;
    let cy = (a.y + b.y) / 2;

    // Perpendicular offset (in screen px) — useful for thick walls.
    // The sign of perpOffset controls which side of the line the label sits on.
    if (perpOffset) {
      const nx = -dy / len, ny = dx / len; // unit normal
      const sign = flipped ? -1 : 1;
      cx += nx * perpOffset * sign;
      cy += ny * perpOffset * sign;
    }

    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width;
    const padX = 5, padY = 2, h = 14;
    // Pill background
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = color || '#c8cdd6';
    ctx.lineWidth = color ? 1.5 : 1;
    roundRect(ctx, -w / 2 - padX, -h / 2 - padY, w + padX * 2, h + padY * 2, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color || '#1c2433';
    ctx.fillText(label, 0, 0);
    ctx.restore();

    // Return the label's screen-space bounding box (in its rotated frame)
    // so callers can hit-test clicks on it.
    return { cx, cy, angle, halfW: w / 2 + padX, halfH: h / 2 + padY };
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function drawSelection(o, showHandles = true) {
    const b = getBounds(o);
    const p = worldToScreen(b.x, b.y);
    const s = state.pxPerMeter * state.view.zoom;
    ctx.save();
    const color = o.locked ? '#9aa5ba' : '#5b8cff';
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x - 3, p.y - 3, b.w * s + 6, b.h * s + 6);
    ctx.setLineDash([]);
    if (!o.locked && showHandles) {
      // resize handles only when editable AND a single object is selected
      ctx.fillStyle = color;
      const handles = getHandles(o);
      for (const h of handles) {
        const sp = worldToScreen(h.x, h.y);
        ctx.fillRect(sp.x - 4, sp.y - 4, 8, 8);
      }
    } else if (o.locked) {
      // small lock badge in the top-left corner of the selection
      ctx.fillStyle = '#1c2433';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('\uD83D\uDD12', p.x - 6, p.y - 18);
    }
    ctx.restore();
  }

  function getHandles(o) {
    if (o.type === 'ruler' || o.type === 'fixture' || o.type === 'note') return [];
    if (o.type === 'room') {
      return [
        { id: 'nw', x: o.x,         y: o.y },
        { id: 'ne', x: o.x + o.w,   y: o.y },
        { id: 'sw', x: o.x,         y: o.y + o.h },
        { id: 'se', x: o.x + o.w,   y: o.y + o.h },
      ];
    }
    if (o.type === 'polygon') {
      // One handle per vertex (id = "v<index>"). Drag to reshape.
      return (o.points || []).map((p, i) => ({ id: 'v' + i, x: p.x, y: p.y }));
    }
    if (o.type === 'wall' || o.type === 'measure') {
      return [
        { id: 'p1', x: o.x1, y: o.y1 },
        { id: 'p2', x: o.x2, y: o.y2 },
      ];
    }
    if (o.type === 'door' || o.type === 'window') {
      // End handle follows rotation so it stays at the actual end of the opening.
      const rad = (o.rot || 0) * Math.PI / 180;
      return [{ id: 'end', x: o.x + Math.cos(rad) * o.w, y: o.y + Math.sin(rad) * o.w }];
    }
    return [];
  }

  function hitHandle(o, wx, wy) {
    const tol = 8 / (state.pxPerMeter * state.view.zoom);
    for (const h of getHandles(o)) {
      if (Math.abs(h.x - wx) < tol && Math.abs(h.y - wy) < tol) return h.id;
    }
    return null;
  }

  // Hit-test wall / door / window dimension labels (rendered in the
  // dimensions pass). Returns the matched object, or null. `sx`,`sy` are
  // screen-space px relative to the canvas top-left.
  function hitDimensionLabel(sx, sy) {
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (o.type !== 'door' && o.type !== 'window' && o.type !== 'wall') continue;
      const r = o._dimLabel;
      if (!r) continue;
      // Primary: rotated AABB hit test in the pill's local frame.
      const cos = Math.cos(-r.angle), sin = Math.sin(-r.angle);
      const lx = (sx - r.cx) * cos - (sy - r.cy) * sin;
      const ly = (sx - r.cx) * sin + (sy - r.cy) * cos;
      if (Math.abs(lx) <= r.halfW && Math.abs(ly) <= r.halfH) return o;
      // Fallback: forgiving radius around the label center (covers any
      // small rotation rounding errors and gives users a slightly larger
      // tap target).
      const radius = Math.max(r.halfW, r.halfH) + 4;
      const dx = sx - r.cx, dy = sy - r.cy;
      if (dx * dx + dy * dy <= radius * radius) return o;
    }
    return null;
  }

  // Hit-test a per-room area label (drawn inside the room). Returns the
  // room object or null. Top-most first so stacked rooms behave naturally.
  function hitAreaLabel(sx, sy) {
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if ((o.type !== 'room' && o.type !== 'polygon') || !o.showArea || !o._areaRect) continue;
      const r = o._areaRect;
      if (Math.abs(sx - r.cx) <= r.halfW && Math.abs(sy - r.cy) <= r.halfH) return o;
    }
    return null;
  }

  // ---------- Status / Hint ----------
  function toolHint(tool) {
    const hints = {
      select: 'Hand tool: click to select and drag objects to move. Empty-drag to pan. Ctrl + click-drag to box-select. Scroll to zoom.',
      marquee: 'Mouse free select: click-drag to draw a selection box. Ctrl + click-drag also works for selection. Hold Shift/Ctrl/Cmd to add/remove. Right-click to switch to Hand tool.',
      room: 'Click and drag to draw a room.',
      wall: 'Click and drag to draw a wall. Hold Shift for straight lines.',
      door: 'Click to drop a door. Drag the end handle to set width / angle.',
      window: 'Click to drop a window. Drag the end handle to set width / angle.',
      text: 'Click to place a text label.',
      measure: 'Click and drag to measure a distance.',
      ruler: 'Click a wall to pin a dimension ruler beside it. Drag the ruler to set how far it sits from the wall.',
      note: 'Click to drop a note. It shows as a numbered pin; the text appears on hover.',
      socket: 'Click to place a socket outlet.',
      switch: 'Click to place a switch.',
      light: 'Click to place a light point.',
      gas: 'Click to place a gas connection.',
      water: 'Click to place a water supply point.',
      drain: 'Click to place a drainage point.',
    };
    return hints[tool] || '';
  }
  function setHint(msg) {
    hint.textContent = msg;
    if (statusMsg) statusMsg.textContent = msg;
  }
  function updateStatus() {
    const pct = document.getElementById('btn-zoom-reset-bar');
    if (pct) pct.textContent = `${Math.round(state.view.zoom * 100)}%`;
    const totalEl = document.getElementById('total-area');
    if (totalEl) {
      let total = 0;
      for (const o of state.objects) {
        if (o.type === 'room') total += roomNetArea(o);
        else if (o.type === 'polygon' && o.closed) total += polygonArea(o.points);
      }
      totalEl.textContent = total > 0 ? `Total: ${fmtArea(total)}` : '';
    }
    // Selection-area badge: shown only when 2+ rooms are selected.
    // Uses z-order net so overlap is counted once and matches the visible
    // perimeter at each click point.
    const selEl = document.getElementById('sel-area');
    if (selEl) {
      ensureSelection();
      const selRooms = state.objects.filter(o => o.type === 'room' && state.selectedIds.has(o.id));
      if (selRooms.length < 2) {
        selEl.textContent = '';
        selEl.title = '';
      } else {
        const { area, lines } = computeSelectionArea(selRooms);
        selEl.textContent = `Sel ${selRooms.length}: ${fmtArea(area)}`;
        const tip = lines.map(ln => `${ln.label}: ${fmtArea(ln.area)}`).join('\n')
          + `\n────────────\nNet: ${fmtArea(area)}`;
        selEl.title = tip;
      }
    }
  }

  // ---------- Tools / Interaction ----------
  let drag = null;
  // Endpoint a shift-dragged wall is currently snapping to, for the overlay.
  let wallSnapHint = null;
  // What the pointer is over, and the length to report for it. Walls report
  // the piece between openings, not the whole run.
  //   { kind, id, wallId?, text, seg?, sx, sy }
  let hover = null;
  // drag = { mode: 'create'|'move'|'resize'|'pan', startScreen, startWorld, original, handle, tempObj }

  canvas.addEventListener('mousedown', (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    // A note pin opens its card, whatever the mode.
    if (e.button === 0) {
      const w0 = screenToWorld(sx, sy);
      const nr = (NOTE_R + 3) / (state.pxPerMeter * state.view.zoom);
      const pin = [...state.objects].reverse()
        .find(o => o.type === 'note' && !o.hidden && Math.hypot(w0.x - o.x, w0.y - o.y) <= nr);
      if (pin) { openNoteCard(pin); if (!READONLY) setSelection([pin.id]); refreshAll(); return; }
      closeNoteCard();
    }

    // View mode: the only thing a press can do is pan.
    if (READONLY) {
      if (e.button === 2) return;
      drag = { mode: 'pan', startScreen: { x: sx, y: sy }, startView: { ...state.view } };
      canvas.style.cursor = 'grabbing';
      return;
    }
    const w = screenToWorld(sx, sy);
    const sw = { x: snap(w.x), y: snap(w.y) };

    // Pan with middle mouse
    if (e.button === 1) {
      drag = { mode: 'pan', startScreen: { x: sx, y: sy }, startView: { ...state.view } };
      canvas.style.cursor = 'grabbing';
      return;
    }

    // Right-click: switch to Hand / Pan mode
    if (e.button === 2) {
      // Cancel any in-progress create drag and remove the partial shape
      if (drag && drag.mode === 'create' && drag.obj) {
        state.objects = state.objects.filter(o => o.id !== drag.obj.id);
      }
      drag = null;
      const btn = document.querySelector('.tool[data-tool="select"]');
      if (btn) btn.click();
      // Try to select whatever is under the cursor (preserve existing
      // multi-selection if the right-clicked object is already part of it).
      const hit = hitTest(w.x, w.y);
      ensureSelection();
      if (hit) {
        if (!state.selectedIds.has(hit.id)) setSelection([hit.id]);
        else state.selectedId = hit.id;
      } else {
        clearSelection();
      }
      refreshAll();
      return;
    }

    // Click on a dimension label:
    //  - wall → flip label to the other side of the wall
    //  - door / window → cycle the label around the right angle (4 positions)
    // Only intercept when the Select tool is active so other drawing tools
    // work normally. Allowed even on locked objects (cosmetic, not geometry).
    if (state.showDims && state.tool === 'select') {
      const dimHit = hitDimensionLabel(sx, sy);
      if (dimHit) {
        pushHistory();
        if (dimHit.type === 'wall') {
          // Flip side: 0 ↔ 1 (legacy -1/+1 also collapse to this)
          dimHit.dimSide = (dimHit.dimSide === 1 || dimHit.dimSide === -1) ? 0 : 1;
        } else {
          dimHit.dimSide = (doorDimSide(dimHit) + 1) % 4;
        }
        setSelection([dimHit.id]);
        refreshAll();
        return;
      }
    }

    // Click on a per-room area label → start dragging it within the room.
    if (state.tool === 'select') {
      const areaHit = hitAreaLabel(sx, sy);
      if (areaHit && !areaHit.locked) {
        pushHistory();
        setSelection([areaHit.id]);
        // Default origin depends on shape type (room uses fractional, polygon
        // uses absolute world coords).
        const defaultPos = areaHit.type === 'polygon'
          ? polygonCentroid(areaHit.points || [])
          : { fx: 0.5, fy: 0.5 };
        drag = {
          mode: 'area-label',
          target: areaHit,
          startWorld: w,
          original: { ...(areaHit.areaPos || defaultPos) },
        };
        canvas.style.cursor = 'grabbing';
        refreshProps(); refreshLayers(); draw();
        return;
      }
    }

    if (state.tool === 'marquee') {
      // Dedicated free-select tool: always marquee on drag.
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      drag = {
        mode: 'marquee',
        startWorld: w,
        endWorld: w,
        additive,
        baseIds: new Set(additive ? state.selectedIds : []),
        fromMarqueeTool: true,
      };
      canvas.style.cursor = 'default';
      refreshProps(); refreshLayers(); draw();
      return;
    }

    if (state.tool === 'select') {
      const hit = hitTest(w.x, w.y);
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (hit) {
        ensureSelection();
        if (additive) {
          toggleSelection(hit.id);
          drag = null;                  // additive click doesn't start a drag
          refreshProps(); refreshLayers(); draw();
          return;
        }
        // Plain click on an object:
        //   - If part of an existing multi-selection → keep selection, drag all.
        //   - Otherwise → select just this one.
        if (!state.selectedIds.has(hit.id)) setSelection([hit.id]);
        else state.selectedId = hit.id;

        if (hit.locked) {
          drag = null;
        } else {
          // Alt-drag → duplicate selection in place and drag the copies.
          if (e.altKey) {
            pushHistory();
            const offset = state.grid.size;
            const newIds = [];
            for (const src of getSelectedObjects()) {
              const o = JSON.parse(JSON.stringify(src));
              o.id = uid();
              translateObject(o, offset, offset);
              state.objects.push(o);
              newIds.push(o.id);
            }
            setSelection(newIds);
          }
          // Multi-select → always move (resize handles only for single).
          if (state.selectedIds.size > 1) {
            const originals = getSelectedObjects().map(o => ({ id: o.id, snap: JSON.parse(JSON.stringify(o)) }));
            drag = { mode: 'multi-move', startWorld: w, originals };
          } else {
            const handle = hitHandle(hit, w.x, w.y);
            if (handle) {
              drag = { mode: 'resize', handle, original: JSON.parse(JSON.stringify(hit)), startWorld: w };
            } else {
              drag = { mode: 'move', original: JSON.parse(JSON.stringify(hit)), startWorld: w };
            }
          }
        }
        refreshProps(); refreshLayers(); draw();
      } else {
        // Empty canvas in Hand tool:
        //  - plain drag pans the sheet
        //  - Shift/Ctrl/Cmd drag performs marquee select
        if (additive) {
          drag = { mode: 'marquee', startWorld: w, endWorld: w, additive, baseIds: new Set(state.selectedIds) };
          canvas.style.cursor = 'crosshair';
        } else {
          drag = {
            mode: 'pan',
            startScreen: { x: sx, y: sy },
            startView: { ...state.view },
            fromEmptySelect: true,
          };
          canvas.style.cursor = 'grabbing';
        }
        refreshProps(); refreshLayers(); draw();
      }
      return;
    }

    // Creation tools
    // Polygon: stateful drafting (no drag). Each click drops a vertex; dbl-click,
    // Enter, or click on the first vertex closes the shape.
    if (state.tool === 'polygon') {
      const v = { x: sw.x, y: sw.y };
      if (!drag || drag.mode !== 'polygon-draft') {
        pushHistory();
        const obj = makeObject('polygon', { points: [v], closed: false });
        state.objects.push(obj);
        setSelection([obj.id]);
        drag = { mode: 'polygon-draft', obj, hover: { x: sw.x, y: sw.y } };
        canvas.style.cursor = 'crosshair';
        draw();
        flash('Click to drop vertices, double-click or Enter to finish');
        return;
      }
      const o = drag.obj;
      // Close if clicking on the first vertex (within ~10px screen)
      if (o.points.length >= 3) {
        const first = o.points[0];
        const tol = 10 / (state.pxPerMeter * state.view.zoom);
        if (Math.hypot(first.x - v.x, first.y - v.y) < tol) {
          finalizePolygonDraft();
          return;
        }
      }
      o.points.push(v);
      draw();
      return;
    }

    pushHistory();
    let obj;
    if (state.tool === 'room') {
      obj = makeObject('room', { x: sw.x, y: sw.y, w: 0, h: 0, label: '' });
    } else if (state.tool === 'wall') {
      obj = makeObject('wall', { x1: sw.x, y1: sw.y, x2: sw.x, y2: sw.y, thickness: state.defaultWallThickness, stroke: '#4a2e1c' });
    } else if (state.tool === 'door') {
      obj = makeObject('door', { x: sw.x, y: sw.y, w: 0.9, rot: 0 });
      state.objects.push(obj);
      setSelection([obj.id]);
      drag = null;
      switchToSelectTool();
      refreshAll();
      return;
    } else if (state.tool === 'window') {
      obj = makeObject('window', { x: sw.x, y: sw.y, w: 1.2, rot: 0 });
      state.objects.push(obj);
      setSelection([obj.id]);
      drag = null;
      switchToSelectTool();
      refreshAll();
      return;
    } else if (state.tool === 'text') {
      // Capture the placement coords now (sw is per-event); the modal is async.
      const placeAt = { x: sw.x, y: sw.y };
      drag = null;
      switchToSelectTool();
      refreshAll();
      showModal({
        kind: 'prompt',
        title: 'Add text',
        message: 'Enter the text to place on the canvas.',
        defaultValue: 'Label',
        placeholder: 'Label',
        okText: 'Add',
      }).then(txt => {
        if (txt == null) return;
        const trimmed = String(txt).trim();
        if (!trimmed) return;
        const o = makeObject('text', { x: placeAt.x, y: placeAt.y, text: trimmed, size: 14, fill: '#111827' });
        state.objects.push(o);
        setSelection([o.id]);
        refreshAll();
      });
      return;
    } else if (state.tool === 'note') {
      const placeAt = { x: sw.x, y: sw.y };
      drag = null;
      switchToSelectTool();
      refreshAll();
      showModal({
        kind: 'prompt',
        title: 'Add note',
        message: 'This appears as a numbered pin. The text shows when you hover it.',
        defaultValue: '',
        placeholder: 'e.g. radiator to be replaced',
        okText: 'Add',
      }).then(txt => {
        if (txt == null) return;
        const trimmed = String(txt).trim();
        if (!trimmed) return;
        pushHistory();
        const o = makeObject('note', { x: placeAt.x, y: placeAt.y, text: trimmed, stroke: NOTE_COLOR });
        state.objects.push(o);
        setSelection([o.id]);
        refreshAll();
        scheduleAutosave();
      });
      return;
    } else if (FIXTURES[state.tool]) {
      pushHistory();
      const o = makeObject('fixture', {
        kind: state.tool, x: sw.x, y: sw.y, rot: 0,
        stroke: FIXTURES[state.tool].color,
      });
      state.objects.push(o);
      setSelection([o.id]);
      drag = null;
      switchToSelectTool();
      refreshAll();
      scheduleAutosave();
      return;
    } else if (state.tool === 'ruler') {
      const hit = hitTest(w.x, w.y);
      if (!hit || hit.type !== 'wall') {
        flash('Click a wall to add a ruler');
        return;
      }
      pushHistory();
      const o = makeObject('ruler', {
        wallId: hit.id,
        offset: defaultRulerOffset(hit),
        x1: hit.x1, y1: hit.y1, x2: hit.x2, y2: hit.y2,
        stroke: '#8a93a6',
      });
      state.objects.push(o);
      setSelection([o.id]);
      drag = null;
      switchToSelectTool();
      refreshAll();
      scheduleAutosave();
      return;
    } else if (state.tool === 'measure') {
      // Never snap measurements to grid
      obj = makeObject('measure', { x1: w.x, y1: w.y, x2: w.x, y2: w.y });
      state.objects.push(obj);
      setSelection([obj.id]);
      drag = { mode: 'create', startWorld: w, obj };
      return;
    }

    if (obj) {
      state.objects.push(obj);
      setSelection([obj.id]);
      drag = { mode: 'create', startWorld: sw, obj };
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = screenToWorld(sx, sy);
    const sw = { x: snap(w.x), y: snap(w.y) };

    if (!drag) {
      // Idle hover: report the length of whatever is under the pointer —
      // a ruler, an opening, or the stretch of wall between two openings.
      // Read-only feedback, so it runs before the per-tool branches.
      const next = computeHover(w.x, w.y, sx, sy);
      const changed = (next && hover)
        ? (next.id !== hover.id || next.kind !== hover.kind || next.text !== hover.text
           || next.sx !== hover.sx || next.sy !== hover.sy)
        : (next !== hover);
      if (changed) { hover = next; draw(); }
      if (next) { canvas.style.cursor = 'pointer'; return; }

      if (state.tool === 'marquee') {
        canvas.style.cursor = 'default';
        return;
      }
      // Idle hover: show pointer cursor over clickable labels.
      if (state.tool === 'select' && hitAreaLabel(sx, sy)) {
        canvas.style.cursor = 'grab';
      } else if (state.showDims && state.tool === 'select' && hitDimensionLabel(sx, sy)) {
        canvas.style.cursor = 'pointer';
      } else if (canvas.style.cursor === 'pointer' || canvas.style.cursor === 'grab') {
        canvas.style.cursor = 'default';
      }
      return;
    }

    if (drag.mode === 'pan') {
      state.view.x = drag.startView.x + (sx - drag.startScreen.x);
      state.view.y = drag.startView.y + (sy - drag.startScreen.y);
      draw();
      return;
    }

    if (drag.mode === 'polygon-draft') {
      drag.hover = { x: sw.x, y: sw.y };
      draw();
      return;
    }

    if (drag.mode === 'create') {
      const o = drag.obj;
      // Measure stays unsnapped so it can show precise non-whole numbers
      const useSnap = !(o.type === 'measure');
      const px = useSnap ? sw.x : w.x;
      const py = useSnap ? sw.y : w.y;
      if (o.type === 'room') {
        o.w = px - drag.startWorld.x;
        o.h = py - drag.startWorld.y;
        if (o.w < 0) { o.x = px; o.w = -o.w; }
        if (o.h < 0) { o.y = py; o.h = -o.h; }
      } else if (o.type === 'wall' || o.type === 'measure') {
        // Constrain to horizontal/vertical with Shift
        if (e.shiftKey) {
          const dx = Math.abs(px - o.x1);
          const dy = Math.abs(py - o.y1);
          if (dx > dy) { o.x2 = px; o.y2 = o.y1; }
          else { o.x2 = o.x1; o.y2 = py; }
        } else {
          o.x2 = px; o.y2 = py;
        }
      }
      draw();
      refreshProps();
      return;
    }

    if (drag.mode === 'marquee') {
      drag.endWorld = w;
      draw();
      return;
    }

    if (drag.mode === 'area-label') {
      const o = drag.target;
      if (!o) return;
      if (o.type === 'polygon') {
        // Free position in world coords; clamp to polygon AABB so it
        // doesn't drift far away.
        const b = getBounds(o);
        const x = Math.max(b.x, Math.min(b.x + b.w, w.x));
        const y = Math.max(b.y, Math.min(b.y + b.h, w.y));
        o.areaPos = { x, y };
      } else {
        // Room: fractional offset within its rectangle.
        const fx = Math.max(0.05, Math.min(0.95, (w.x - o.x) / o.w));
        const fy = Math.max(0.05, Math.min(0.95, (w.y - o.y) / o.h));
        o.areaPos = { fx, fy };
      }
      draw();
      return;
    }

    if (drag.mode === 'multi-move') {
      const dx = snap(w.x - drag.startWorld.x);
      const dy = snap(w.y - drag.startWorld.y);
      for (const rec of drag.originals) {
        const o = state.objects.find(x => x.id === rec.id);
        if (!o || o.locked) continue;
        const orig = rec.snap;
        if (o.type === 'wall' || o.type === 'measure') {
          o.x1 = orig.x1 + dx; o.y1 = orig.y1 + dy;
          o.x2 = orig.x2 + dx; o.y2 = orig.y2 + dy;
        } else if (o.type === 'room') {
          o.x = orig.x + dx; o.y = orig.y + dy;
        } else if (o.type === 'polygon') {
          o.points = orig.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
        } else {
          o.x = orig.x + dx; o.y = orig.y + dy;
        }
      }
      draw();
      refreshProps();
      return;
    }

    if (drag.mode === 'move') {
      const o = state.objects.find(x => x.id === state.selectedId);
      if (!o) return;
      let dx = snap(w.x - drag.startWorld.x);
      let dy = snap(w.y - drag.startWorld.y);
      const orig = drag.original;
      // Hold Shift while dragging a wall to snap it onto another wall's
      // endpoint. The delta is taken raw (not grid-snapped) so the ends meet
      // exactly, and the whole wall moves — no rotation, no length change.
      wallSnapHint = null;
      if (e.shiftKey && o.type === 'wall') {
        const raw = { x: w.x - drag.startWorld.x, y: w.y - drag.startWorld.y };
        const hit = findWallEndSnap(o, orig, raw);
        if (hit) { dx = hit.dx; dy = hit.dy; wallSnapHint = hit.point; }
      }
      if (o.type === 'ruler') {
        // A ruler only slides along its normal — it stays parallel to, and
        // spans exactly, the wall it annotates.
        const L = rulerLine(orig);
        if (L) {
          const rx = w.x - drag.startWorld.x, ry = w.y - drag.startWorld.y;
          o.offset = (orig.offset || 0) + rx * L.nx + ry * L.ny;
        }
        draw();
        refreshProps();
        return;
      }
      if (o.type === 'room') { o.x = orig.x + dx; o.y = orig.y + dy; }
      else if (o.type === 'wall' || o.type === 'measure') {
        o.x1 = orig.x1 + dx; o.y1 = orig.y1 + dy;
        o.x2 = orig.x2 + dx; o.y2 = orig.y2 + dy;
      } else if (o.type === 'polygon') {
        o.points = orig.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
      } else { o.x = orig.x + dx; o.y = orig.y + dy; }
      draw();
      refreshProps();
      return;
    }

    if (drag.mode === 'resize') {
      const o = state.objects.find(x => x.id === state.selectedId);
      if (!o) return;
      const orig = drag.original;
      if (o.type === 'room') {
        let x1 = orig.x, y1 = orig.y, x2 = orig.x + orig.w, y2 = orig.y + orig.h;
        if (drag.handle.includes('w')) x1 = sw.x;
        if (drag.handle.includes('e')) x2 = sw.x;
        if (drag.handle.includes('n')) y1 = sw.y;
        if (drag.handle.includes('s')) y2 = sw.y;
        o.x = Math.min(x1, x2); o.y = Math.min(y1, y2);
        o.w = Math.max(0.1, Math.abs(x2 - x1));
        o.h = Math.max(0.1, Math.abs(y2 - y1));
      } else if (o.type === 'wall' || o.type === 'measure') {
        const useSnap = o.type !== 'measure';
        const px = useSnap ? sw.x : w.x;
        const py = useSnap ? sw.y : w.y;
        if (drag.handle === 'p1') { o.x1 = px; o.y1 = py; }
        else { o.x2 = px; o.y2 = py; }
      } else if (o.type === 'door' || o.type === 'window') {
        const dx = sw.x - orig.x;
        const dy = sw.y - orig.y;
        o.w = Math.max(0.3, Math.sqrt(dx * dx + dy * dy));
        o.rot = Math.atan2(dy, dx) * 180 / Math.PI;
      } else if (o.type === 'polygon' && drag.handle && drag.handle.startsWith('v')) {
        const idx = parseInt(drag.handle.slice(1), 10);
        if (!isNaN(idx) && o.points[idx]) {
          o.points[idx] = { x: sw.x, y: sw.y };
        }
      }
      draw();
      refreshProps();
      return;
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (hover) { hover = null; draw(); }
  });

  canvas.addEventListener('mouseup', () => {
    wallSnapHint = null;
    // Empty click in Select mode should still clear selection.
    if (drag && drag.mode === 'pan' && drag.fromEmptySelect) {
      const moved = Math.hypot(state.view.x - drag.startView.x, state.view.y - drag.startView.y);
      if (moved < 2) clearSelection();
    }
    if (drag && drag.mode === 'create') {
      const o = drag.obj;
      // Discard zero-size shapes
      if ((o.type === 'room' && (o.w < 0.1 || o.h < 0.1)) ||
          ((o.type === 'wall' || o.type === 'measure') &&
            Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 0.1)) {
        state.objects.pop();
        clearSelection();
      } else {
        // Successful create — auto-switch back to Select / Move so the next
        // click doesn't accidentally start another shape.
        switchToSelectTool();
      }
    }
    if (drag && drag.mode === 'marquee') {
      const a = drag.startWorld, b = drag.endWorld;
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      // In dedicated marquee tool, tiny drag behaves like a click-to-select.
      if ((w < 0.05 && h < 0.05) && drag.fromMarqueeTool) {
        const hit = hitTest(a.x, a.y);
        if (hit) {
          if (drag.additive) toggleSelection(hit.id);
          else setSelection([hit.id]);
        } else if (!drag.additive) {
          clearSelection();
        }
      } else if (w >= 0.05 || h >= 0.05) {
        const hits = new Set(drag.additive ? drag.baseIds : []);
        for (const o of state.objects) {
          const ob = getBounds(o);
          // Intersect rectangles
          if (ob.x + ob.w >= x && ob.x <= x + w && ob.y + ob.h >= y && ob.y <= y + h) {
            hits.add(o.id);
          }
        }
        setSelection([...hits]);
      }
    }
    if (drag && (drag.mode === 'move' || drag.mode === 'multi-move' || drag.mode === 'resize')) {
      // Snapshot history at the END of an interactive drag so an undo
      // restores the position before the drag started, not mid-drag.
      // (pushHistory is already called for create/clipboard ops.)
    }
    // Polygon drafting is stateful across many clicks — keep the drag alive.
    if (drag && drag.mode === 'polygon-draft') {
      refreshLayers();
      return;
    }
    drag = null;
    canvas.style.cursor = 'default';
    refreshAll();
  });

  // Double-click finalizes the polygon being drafted.
  canvas.addEventListener('dblclick', (e) => {
    if (drag && drag.mode === 'polygon-draft') {
      e.preventDefault();
      finalizePolygonDraft();
    }
  });

  // Programmatically activate the Hand tool (also updates toolbar state).
  function switchToSelectTool() {
    if (state.tool === 'select') return;
    const btn = document.querySelector('.tool[data-tool="select"]');
    if (btn) btn.click();
    else state.tool = 'select';
  }

  // End an in-progress polygon draft: close it if there are enough vertices,
  // otherwise discard. Always switches back to Select.
  function finalizePolygonDraft() {
    if (!drag || drag.mode !== 'polygon-draft') return;
    const o = drag.obj;
    if (!o || (o.points || []).length < 3) {
      // Not enough vertices for a real shape — discard
      state.objects = state.objects.filter(x => x !== o);
      clearSelection();
    } else {
      o.closed = true;
    }
    drag = null;
    canvas.style.cursor = 'default';
    switchToSelectTool();
    refreshAll();
    scheduleAutosave();
  }
  function cancelPolygonDraft() {
    if (!drag || drag.mode !== 'polygon-draft') return;
    state.objects = state.objects.filter(x => x !== drag.obj);
    clearSelection();
    drag = null;
    canvas.style.cursor = 'default';
    switchToSelectTool();
    refreshAll();
  }

  // Create 4 wall objects along a room's edges (top, right, bottom, left).
  // Walls are appended after the room so they render on top of the fill.
  // Returns the array of new wall objects.
  function addWallsForRoom(room) {
    const t = state.defaultWallThickness;
    const stroke = '#4a2e1c';
    const x1 = room.x, y1 = room.y;
    const x2 = room.x + room.w, y2 = room.y + room.h;
    const sides = [
      { x1, y1,     x2,     y2: y1 }, // top
      { x1: x2, y1, x2,     y2 },     // right
      { x1, y1: y2, x2,     y2 },     // bottom
      { x1, y1,     x2: x1, y2 },     // left
    ];
    const created = [];
    for (const s of sides) {
      const w = makeObject('wall', { ...s, thickness: t, stroke });
      state.objects.push(w);
      created.push(w);
    }
    return created;
  }

  // Add one wall per edge of a polygon (closed). Returns the new wall objects.
  function addWallsForPolygon(poly) {
    const pts = poly.points || [];
    if (pts.length < 2) return [];
    const t = state.defaultWallThickness;
    const stroke = '#4a2e1c';
    const created = [];
    const edges = poly.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < edges; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const w = makeObject('wall', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        thickness: t, stroke,
      });
      state.objects.push(w);
      created.push(w);
    }
    return created;
  }

  // Shoelace signed area; absolute value gives the polygon's enclosed area.
  function polygonArea(pts) {
    if (!pts || pts.length < 3) return 0;
    let s = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      s += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    }
    return Math.abs(s) * 0.5;
  }
  // Area-weighted centroid (handles non-convex shapes correctly).
  // Falls back to bbox center for degenerate polygons.
  function polygonCentroid(pts) {
    if (!pts || pts.length < 3) {
      let x = 0, y = 0;
      for (const p of pts || []) { x += p.x; y += p.y; }
      return { x: x / Math.max(1, (pts || []).length), y: y / Math.max(1, (pts || []).length) };
    }
    let cx = 0, cy = 0, a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const cross = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
      a += cross;
      cx += (pts[j].x + pts[i].x) * cross;
      cy += (pts[j].y + pts[i].y) * cross;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-9) {
      // Degenerate fallback (zero-area polygon)
      let x = 0, y = 0;
      for (const p of pts) { x += p.x; y += p.y; }
      return { x: x / pts.length, y: y / pts.length };
    }
    return { x: cx / (6 * a), y: cy / (6 * a) };
  }

  // ---------- Right-click context menu ----------
  const ctxMenu = document.getElementById('context-menu');

  // Uncommitted typed-length edits belonging to the open menu. Flushed when
  // the menu closes so a preview is never left without its undo step.
  const pendingCtxCommits = [];

  function flushCtxCommits() {
    while (pendingCtxCommits.length) pendingCtxCommits.pop()();
  }

  function hideContextMenu() {
    if (!ctxMenu) return;
    flushCtxCommits();
    ctxMenu.hidden = true;
    ctxMenu.setAttribute('aria-hidden', 'true');
    ctxMenu.innerHTML = '';
  }

  function ctxItem(label, onClick, opts = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (opts.danger ? ' danger' : '');
    b.disabled = !!opts.disabled;
    b.innerHTML =
      `<span>${label}</span>` +
      (opts.shortcut ? `<span class="ctx-shortcut">${opts.shortcut}</span>` : '');
    b.addEventListener('click', () => {
      if (b.disabled) return;
      hideContextMenu();
      onClick();
    });
    return b;
  }

  // Compact horizontal icon-button row for the context menu (e.g. Undo / Redo
  // / Delete at the top). Each item:
  //   { iconId, title, shortcut?, onClick, disabled, danger }
  function ctxIconRow(items, opts = {}) {
    const row = document.createElement('div');
    row.className = 'ctx-icon-row' + (opts.compact ? ' compact' : '');
    items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-icon-btn' + (it.danger ? ' danger' : '');
      b.disabled = !!it.disabled;
      b.title = it.title || '';
      b.setAttribute('aria-label', it.title || '');
      b.innerHTML =
        (it.text != null
          ? `<span class="ctx-icon-text">${it.text}</span>`
          : `<svg class="ic"><use href="#${it.iconId}"/></svg>`) +
        (it.shortcut ? `<span class="ctx-icon-kbd">${it.shortcut}</span>` : '');
      b.addEventListener('click', () => {
        if (b.disabled) return;
        hideContextMenu();
        it.onClick();
      });
      row.appendChild(b);
    });
    return row;
  }
  function ctxSep() {
    const d = document.createElement('div');
    d.className = 'ctx-sep';
    return d;
  }
  function ctxSection(text) {
    const d = document.createElement('div');
    d.className = 'ctx-section';
    d.textContent = text;
    return d;
  }
  // Toggle row — shows a check on the left when active. Closes the menu and
  // dispatches `change` on the linked sidebar input so the existing handler
  // fires (autosave, redraw, state sync).
  function ctxToggle(label, isOn, inputId) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item ctx-toggle' + (isOn ? ' on' : '');
    b.setAttribute('role', 'menuitemcheckbox');
    b.setAttribute('aria-checked', String(!!isOn));
    b.innerHTML =
      `<span class="ctx-check" aria-hidden="true"></span>` +
      `<span class="ctx-toggle-label">${label}</span>`;
    b.addEventListener('click', () => {
      hideContextMenu();
      const chk = document.getElementById(inputId);
      if (chk) { chk.checked = !chk.checked; chk.dispatchEvent(new Event('change')); }
    });
    return b;
  }
  function ctxDisplayToggles(frag) {
    frag.appendChild(ctxToggle('Show grid', state.grid.show, 'opt-grid'));
    frag.appendChild(ctxToggle('Snap to grid', state.grid.snap, 'opt-snap'));
    frag.appendChild(ctxToggle('Show dimensions', state.showDims, 'opt-dims'));
  }
  function ctxSwatchRow(palette, currentHex, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'ctx-swatches';
    const target = (currentHex || '').toLowerCase();
    palette.forEach(hex => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (hex.toLowerCase() === target ? ' active' : '');
      b.style.backgroundColor = hex;
      b.title = hex;
      b.addEventListener('click', () => { hideContextMenu(); onPick(hex); });
      wrap.appendChild(b);
    });
    return wrap;
  }

  // Inline numeric stepper used inside the context menu (e.g. Outline width).
  // Stays open while clicking +/-; the value updates live and `onChange`
  // receives the clamped new value.
  function ctxStepper(getValue, onChange, opts = {}) {
    const min = opts.min ?? 1;
    const max = opts.max ?? 20;
    const step = opts.step ?? 1;
    const wrap = document.createElement('div');
    wrap.className = 'ctx-stepper';
    const dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'ctx-step-btn';
    dec.textContent = '\u2212'; // minus sign
    const val = document.createElement('span');
    val.className = 'ctx-step-value';
    const inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'ctx-step-btn';
    inc.textContent = '+';
    const sync = () => {
      const v = getValue();
      val.textContent = String(v);
      dec.disabled = v <= min;
      inc.disabled = v >= max;
    };
    const bump = (delta) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = getValue();
      const next = Math.max(min, Math.min(max, cur + delta));
      if (next === cur) return;
      onChange(next);
      sync();
    };
    dec.addEventListener('click', bump(-step));
    inc.addEventListener('click', bump(+step));
    sync();
    wrap.appendChild(dec);
    wrap.appendChild(val);
    wrap.appendChild(inc);
    return wrap;
  }

  // Compact compound length editor for the right-click menu. Looks like
  // `[Width  ][ 12 ft  3 in ]` on a single row, or `[Width  ][ 3250 mm ]`
  // in millimeter mode (no minor field).
  //
  // Typing previews live on the canvas but does NOT touch history. The edit
  // is committed — one undo step, one autosave — on Enter or blur; Esc
  // reverts to the value the field held when the burst started. `apply`
  // mutates the object and redraws; it must not push history itself.
  function ctxLenInput(label, getMeters, apply, opts = {}) {
    const row = document.createElement('div');
    row.className = 'ctx-section-row ctx-len-row';
    const lbl = document.createElement('span');
    lbl.className = 'ctx-section ctx-inline-section';
    lbl.textContent = label;
    row.appendChild(lbl);

    const isFt = state.units === 'ft';
    const isMm = state.units === 'mm';
    const wrap = document.createElement('div');
    wrap.className = 'len-input ctx-len-input';
    const major = document.createElement('input');
    major.type = 'number';
    major.className = 'len-major';
    major.min = '0';
    // `any` so typed fractions (3.25 in, 12.5 mm) are not flagged invalid or
    // snapped to a step by the browser.
    major.step = isMm ? 'any' : '1';
    major.disabled = !!opts.disabled;
    const uMaj = document.createElement('span');
    uMaj.className = 'len-major-unit';
    uMaj.textContent = isFt ? 'ft' : isMm ? 'mm' : 'm';
    const minor = document.createElement('input');
    minor.type = 'number';
    minor.className = 'len-minor';
    minor.min = '0';
    minor.step = 'any';
    minor.disabled = !!opts.disabled;
    const uMin = document.createElement('span');
    uMin.className = 'len-minor-unit';
    uMin.textContent = isFt ? 'in' : 'cm';
    if (isMm) wrap.append(major, uMaj);
    else wrap.append(major, uMaj, minor, uMin);
    row.appendChild(wrap);

    const sizeOf = (input) => {
      const len = (input.value || '').length;
      input.size = Math.max(1, Math.min(7, len || 1));
    };
    // Round to `dp` decimals and drop trailing zeros, so a typed 3.25"
    // survives a redraw instead of being snapped to 3.5".
    const trim = (v, dp) => String(Math.round(v * 10 ** dp) / 10 ** dp);

    // Decompose meters into the two fields.
    const writeFromMeters = (m) => {
      if (m == null || isNaN(m)) { major.value = ''; minor.value = ''; }
      else if (isMm) { major.value = trim(m * 1000, 1); }
      else if (isFt) {
        const totalIn = (m / M_PER_FT) * 12;
        let ft = Math.trunc(totalIn / 12);
        let inches = Math.round((totalIn - ft * 12) * 100) / 100;
        if (inches < 0) { inches += 12; ft -= 1; }
        if (inches >= 12) { ft += 1; inches -= 12; }
        major.value = String(ft);
        minor.value = trim(inches, 2);
      } else {
        const totalCm = m * 100;
        let mm = Math.trunc(totalCm / 100);
        let cm = Math.round((totalCm - mm * 100) * 100) / 100;
        if (cm < 0) { cm += 100; mm -= 1; }
        if (cm >= 100) { mm += 1; cm -= 100; }
        major.value = String(mm);
        minor.value = trim(cm, 2);
      }
      sizeOf(major); sizeOf(minor);
    };
    writeFromMeters(getMeters());

    // --- Edit burst bookkeeping -------------------------------------------
    let baseline = null;  // history snapshot from before the burst
    let original = null;  // meters before the burst, for Esc
    let dirty = false;

    const preview = (m) => {
      if (baseline === null) { baseline = historySnapshot(); original = getMeters(); }
      apply(m);
      dirty = true;
    };
    const commit = () => {
      if (!dirty) { baseline = null; return; }
      pushHistorySnapshot(baseline);
      baseline = null; dirty = false;
      refreshLayers();
      scheduleAutosave();
      writeFromMeters(getMeters());
    };
    const cancel = () => {
      if (dirty && original != null) { apply(original); }
      baseline = null; dirty = false;
      writeFromMeters(getMeters());
    };
    // The menu can be torn down while a field still holds an uncommitted
    // edit (click elsewhere, Escape). Flush it rather than lose the undo
    // step and the autosave.
    pendingCtxCommits.push(() => commit());

    const onInput = () => {
      sizeOf(major); sizeOf(minor);
      const a = parseFloat(major.value);
      const b = isMm ? NaN : parseFloat(minor.value);
      const aOk = !isNaN(a), bOk = !isNaN(b);
      if (!aOk && !bOk) return;
      let meters;
      if (isMm) meters = (aOk ? a : 0) / 1000;
      else if (isFt) meters = ftToM((aOk ? a : 0) + (bOk ? b : 0) / 12);
      else meters = (aOk ? a : 0) + (bOk ? b : 0) / 100;
      if (meters > 0) preview(meters);
    };
    major.addEventListener('input', onInput);
    minor.addEventListener('input', onInput);
    [major, minor].forEach(i => {
      i.addEventListener('blur', commit);
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); return; }
        if (e.key === 'Escape') {
          // First Esc reverts an in-progress edit; with nothing to revert it
          // falls through to the app and closes the menu.
          if (dirty) { e.preventDefault(); e.stopPropagation(); cancel(); }
          return;
        }
        // Swallow everything else so single-key tool shortcuts (r, w, d…)
        // don't fire while typing.
        e.stopPropagation();
      });
    });
    // Keep the menu open while clicking inside the input
    wrap.addEventListener('mousedown', (e) => e.stopPropagation());
    return row;
  }

  // Inline single-line Zoom row: `[Zoom ][ − 100% + ]`
  function ctxZoomRow() {
    const row = document.createElement('div');
    row.className = 'ctx-section-row';
    const lbl = document.createElement('span');
    lbl.className = 'ctx-section ctx-inline-section';
    lbl.textContent = 'Zoom';
    row.appendChild(lbl);

    const group = document.createElement('div');
    group.className = 'ctx-presets ctx-zoom-presets';
    const items = [
      { text: '−', title: 'Zoom out (−)', onClick: () => zoomBy(1 / 1.2) },
      { text: `${Math.round(state.view.zoom * 100)}%`, title: 'Reset view (0)', onClick: resetView },
      { text: '+', title: 'Zoom in (+)', onClick: () => zoomBy(1.2) },
    ];
    items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-preset';
      b.textContent = it.text;
      b.title = it.title;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        it.onClick();
        // Live-refresh the % label without rebuilding the menu.
        const pct = group.children[1];
        if (pct) pct.textContent = `${Math.round(state.view.zoom * 100)}%`;
      });
      group.appendChild(b);
    });
    row.appendChild(group);
    return row;
  }

  // Angle preset row for doors / windows — `[Angle ][ 0° 90° 180° 270° ]`.
  // The button matching the current angle is highlighted; click sets `o.rot`.
  function ctxAnglePresets(o) {
    const row = document.createElement('div');
    row.className = 'ctx-section-row';
    const lbl = document.createElement('span');
    lbl.className = 'ctx-section ctx-inline-section';
    lbl.textContent = 'Angle';
    row.appendChild(lbl);

    const group = document.createElement('div');
    group.className = 'ctx-presets';
    const cur = ((o.rot || 0) % 360 + 360) % 360;
    [0, 90, 180, 270].forEach(a => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-preset' + (Math.round(cur) === a ? ' active' : '');
      b.textContent = `${a}\u00b0`;
      b.disabled = !!o.locked;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (o.locked) return;
        pushHistory();
        o.rot = a;
        // Live-update active highlight without rebuilding the whole menu
        group.querySelectorAll('.ctx-preset').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        draw();
        refreshLayers();
        scheduleAutosave();
      });
      group.appendChild(b);
    });
    row.appendChild(group);
    return row;
  }

  // Flip row — single button that mirrors the door/window swing direction
  // (re-uses the existing `flipOpening`, same effect as double-clicking).
  function ctxFlipRow(o) {
    const row = document.createElement('div');
    row.className = 'ctx-section-row';
    const lbl = document.createElement('span');
    lbl.className = 'ctx-section ctx-inline-section';
    lbl.textContent = 'Flip';
    row.appendChild(lbl);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-preset';
    btn.textContent = 'Mirror swing';
    btn.disabled = !!o.locked;
    btn.title = 'Mirror the opening so the swing arc reverses';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (o.locked) return;
      pushHistory();
      flipOpening(o);
      draw();
      refreshLayers();
      scheduleAutosave();
    });
    const group = document.createElement('div');
    group.className = 'ctx-presets';
    group.appendChild(btn);
    row.appendChild(group);
    return row;
  }

  // Rename menu row that swaps itself into an inline <input> on click.
  // Enter / blur commits, Escape cancels. The menu stays open while editing.
  // Allowed even when the object is locked (lock blocks geometry, not labels).
  function buildRenameItem(o) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-item';
    btn.innerHTML = `<span>Rename</span><span class="ctx-shortcut">F2</span>`;

    const startEdit = () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ctx-rename-input';
      input.value = o.label || o.text || '';
      input.placeholder = 'Name…';
      input.maxLength = 80;
      btn.replaceWith(input);
      input.focus();
      input.select();

      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        const prev = o.label || (o.type === 'text' ? o.text : '') || '';
        if (next !== prev) {
          pushHistory();
          o.label = next;
          if (o.type === 'text') o.text = next;
          refreshAll();
          scheduleAutosave();
        }
        hideContextMenu();
      };
      const cancel = () => {
        if (done) return;
        done = true;
        hideContextMenu();
      };
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      });
      input.addEventListener('blur', commit);
      // Stop clicks inside the input from bubbling to the outside-click handler
      input.addEventListener('mousedown', (ev) => ev.stopPropagation());
    };

    btn.addEventListener('click', startEdit);
    return btn;
  }

  function buildObjectMenu(o) {
    const frag = document.createDocumentFragment();
    const idx = state.objects.indexOf(o);
    const isFront = idx === state.objects.length - 1;
    const isBack = idx === 0;
    const supportsFill = o.type === 'room' || o.type === 'polygon' || o.type === 'window' || o.type === 'text';
    const supportsStroke = o.type !== 'text' && o.type !== 'ruler';
    const supportsOutline = o.type === 'room' || o.type === 'polygon' || o.type === 'wall';

    // Quick-action icon row: Undo / Redo / Delete
    frag.appendChild(ctxIconRow([
      { iconId: 'i-undo',  title: 'Undo (Ctrl+Z)', shortcut: 'Undo',   onClick: undo, disabled: state.history.length === 0 },
      { iconId: 'i-redo',  title: 'Redo (Ctrl+Shift+Z / Ctrl+Y)', shortcut: 'Redo',   onClick: redo, disabled: state.future.length === 0 },
      { iconId: 'i-trash', title: 'Delete (Del)',  shortcut: 'Delete', danger: true,  disabled: !!o.locked,
        onClick: () => { if (!state.selectedIds.has(o.id)) setSelection([o.id]); deleteSelected(); } },
    ]));
    frag.appendChild(ctxSep());

    // Clipboard row
    frag.appendChild(ctxItem('Copy', () => {
      if (!state.selectedIds.has(o.id)) setSelection([o.id]);
      copySelection();
    }, { shortcut: 'Ctrl+C' }));
    frag.appendChild(ctxItem('Cut', () => {
      if (!state.selectedIds.has(o.id)) setSelection([o.id]);
      cutSelection();
    }, { shortcut: 'Ctrl+X', disabled: !!o.locked }));
    frag.appendChild(ctxItem('Duplicate', () => {
      if (!state.selectedIds.has(o.id)) setSelection([o.id]);
      duplicateSelection();
    }, { shortcut: 'Ctrl+D' }));
    frag.appendChild(ctxItem('Paste', pasteClipboard, { shortcut: 'Ctrl+V', disabled: clipboard.length === 0 }));
    frag.appendChild(ctxSep());

    frag.appendChild(buildRenameItem(o));

    frag.appendChild(ctxSep());

    frag.appendChild(ctxItem(o.locked ? 'Unlock' : 'Lock', () => {
      pushHistory();
      o.locked = !o.locked;
      refreshAll();
      scheduleAutosave();
    }));
    frag.appendChild(ctxItem('Bring to front', () => {
      if (isFront) return;
      pushHistory();
      state.objects.splice(idx, 1);
      state.objects.push(o);
      refreshAll();
      scheduleAutosave();
    }, { disabled: isFront }));
    frag.appendChild(ctxItem('Send to back', () => {
      if (isBack) return;
      pushHistory();
      state.objects.splice(idx, 1);
      state.objects.unshift(o);
      refreshAll();
      scheduleAutosave();
    }, { disabled: isBack }));

    // Room-specific: add 4 walls along the room's edges as separate,
    // individually-editable wall objects.
    if (o.type === 'room') {
      frag.appendChild(ctxItem('Add walls', () => {
        pushHistory();
        const walls = addWallsForRoom(o);
        flash(`Added ${walls.length} walls`);
        refreshAll();
        scheduleAutosave();
      }, { disabled: !!o.locked }));
      // Per-room area label toggle. Drag the label inside the room to move it.
      frag.appendChild(ctxItem(o.showArea ? 'Hide area' : 'Show area', () => {
        pushHistory();
        o.showArea = !o.showArea;
        if (o.showArea && !o.areaPos) o.areaPos = { fx: 0.5, fy: 0.5 };
        refreshAll();
        scheduleAutosave();
      }));
    }

    // Polygon-specific: same Add walls / Show area capabilities.
    if (o.type === 'polygon' && o.closed) {
      frag.appendChild(ctxItem('Add walls', () => {
        pushHistory();
        const walls = addWallsForPolygon(o);
        flash(`Added ${walls.length} walls`);
        refreshAll();
        scheduleAutosave();
      }, { disabled: !!o.locked }));
      frag.appendChild(ctxItem(o.showArea ? 'Hide area' : 'Show area', () => {
        pushHistory();
        o.showArea = !o.showArea;
        // Centroid is the natural default; user can drag it elsewhere.
        if (o.showArea && !o.areaPos) {
          const c = polygonCentroid(o.points);
          o.areaPos = { x: c.x, y: c.y };
        }
        refreshAll();
        scheduleAutosave();
      }));
    }

    // Inline length editors (Width / Height / Length / Thickness) — only for
    // the types where these dimensions are directly editable. The handlers
    // below only mutate + redraw; ctxLenInput owns history and autosave.
    const dimRows = [];
    const lenOpts = { disabled: !!o.locked };
    const applyBound = (key) => (m) => {
      const b = getBounds(o);
      setBounds(o, { ...b, [key]: m });
      draw();
    };
    if (o.type === 'room') {
      dimRows.push(ctxLenInput('Width',  () => o.w, applyBound('w'), lenOpts));
      dimRows.push(ctxLenInput('Height', () => o.h, applyBound('h'), lenOpts));
    } else if (o.type === 'door' || o.type === 'window') {
      dimRows.push(ctxLenInput('Width', () => o.w, (m) => {
        o.w = Math.max(0.3, m);
        draw();
      }, lenOpts));
      // Quick angle presets — 0° / 90° / 180° / 270°
      dimRows.push(ctxAnglePresets(o));
      // Flip the swing direction (mirror about the opening's end-point).
      // Same effect as double-clicking the door/window.
      dimRows.push(ctxFlipRow(o));
    } else if (o.type === 'wall') {
      // Length resizes along the wall's own axis, anchored at its start point.
      dimRows.push(ctxLenInput('Length',
        () => segmentLength(o),
        (m) => { setSegmentLength(o, m); draw(); },
        lenOpts
      ));
      dimRows.push(ctxLenInput('Thickness',
        () => o.thickness || state.defaultWallThickness,
        (m) => {
          o.thickness = Math.max(0.01, m);
          state.defaultWallThickness = o.thickness;
          draw();
        },
        lenOpts
      ));
    } else if (o.type === 'ruler') {
      dimRows.push(ctxLenInput('Distance',
        () => Math.abs(o.offset || 0),
        (m) => { o.offset = (o.offset < 0 ? -1 : 1) * m; draw(); },
        lenOpts
      ));
      dimRows.push(ctxItem('Flip to other side', () => {
        pushHistory();
        o.offset = -(o.offset || 0);
        refreshAll();
        scheduleAutosave();
      }, { disabled: !!o.locked }));
    } else if (o.type === 'measure') {
      dimRows.push(ctxLenInput('Length',
        () => segmentLength(o),
        (m) => { setSegmentLength(o, m); draw(); },
        lenOpts
      ));
    }
    if (dimRows.length) {
      frag.appendChild(ctxSep());
      dimRows.forEach(r => frag.appendChild(r));
    }

    if (supportsFill || supportsStroke) frag.appendChild(ctxSep());

    if (supportsFill) {
      frag.appendChild(ctxSection('Fill'));
      frag.appendChild(ctxSwatchRow(FILL_SWATCHES, o.fill, (hex) => {
        pushHistory();
        o.fill = hex;
        refreshAll();
        scheduleAutosave();
      }));
    }
    if (supportsStroke) {
      frag.appendChild(ctxSection('Border'));
      frag.appendChild(ctxSwatchRow(STROKE_SWATCHES, o.stroke, (hex) => {
        pushHistory();
        o.stroke = hex;
        refreshAll();
        scheduleAutosave();
      }));
    }
    if (supportsOutline) {
      const row = document.createElement('div');
      row.className = 'ctx-section-row';
      const label = document.createElement('span');
      label.className = 'ctx-section ctx-inline-section';
      label.textContent = 'Border Thickness';
      row.appendChild(label);
      row.appendChild(ctxStepper(
        () => o.strokeWidth || 2,
        (v) => {
          pushHistory();
          o.strokeWidth = v;
          draw();
          refreshLayers();
          scheduleAutosave();
        },
        { min: 1, max: 20, step: 1 }
      ));
      frag.appendChild(row);
    }

    return frag;
  }

  function buildEmptyMenu() {
    const frag = document.createDocumentFragment();
    // Quick-action icon row: Undo / Redo
    frag.appendChild(ctxIconRow([
      { iconId: 'i-undo', title: 'Undo (Ctrl+Z)', shortcut: 'Undo', onClick: undo, disabled: state.history.length === 0 },
      { iconId: 'i-redo', title: 'Redo (Ctrl+Shift+Z / Ctrl+Y)', shortcut: 'Redo', onClick: redo, disabled: state.future.length === 0 },
    ]));
    frag.appendChild(ctxSep());
    frag.appendChild(ctxItem('Paste', pasteClipboard, { shortcut: 'Ctrl+V', disabled: clipboard.length === 0 }));
    frag.appendChild(ctxItem('Select all', selectAll, { shortcut: 'Ctrl+A', disabled: state.objects.length === 0 }));
    frag.appendChild(ctxSep());
    frag.appendChild(ctxZoomRow());
    frag.appendChild(ctxSep());
    frag.appendChild(ctxSection('Display'));
    ctxDisplayToggles(frag);
    return frag;
  }

  function showContextMenu(clientX, clientY, content) {
    if (!ctxMenu) return;
    ctxMenu.innerHTML = '';
    ctxMenu.appendChild(content);
    ctxMenu.hidden = false;
    ctxMenu.setAttribute('aria-hidden', 'false');
    // Position, then clamp to viewport on next frame once dimensions are known
    ctxMenu.style.left = `${clientX}px`;
    ctxMenu.style.top = `${clientY}px`;
    requestAnimationFrame(() => {
      const r = ctxMenu.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      let nx = clientX, ny = clientY;
      if (r.right > vw - 6) nx = Math.max(6, vw - r.width - 6);
      if (r.bottom > vh - 6) ny = Math.max(6, vh - r.height - 6);
      ctxMenu.style.left = `${nx}px`;
      ctxMenu.style.top = `${ny}px`;
    });
  }

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (READONLY) return;
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = screenToWorld(sx, sy);
    const hit = hitTest(w.x, w.y);
    // Commit anything typed into the previous menu before its rows are
    // replaced (registration order matters: flush before building).
    flushCtxCommits();
    const content = hit ? buildObjectMenu(hit) : buildEmptyMenu();
    showContextMenu(e.clientX, e.clientY, content);
  });

  // Dismiss on outside interaction
  document.addEventListener('mousedown', (e) => {
    if (ctxMenu.hidden) return;
    if (!ctxMenu.contains(e.target)) hideContextMenu();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ctxMenu.hidden) hideContextMenu();
  });
  window.addEventListener('blur', hideContextMenu);
  canvas.addEventListener('wheel', hideContextMenu, { passive: true });

  // Double-click on a door/window flips its direction (mirrors the opening
  // about its current end-point). Visually it stays in the same span but the
  // swing arc and dimension direction reverse.
  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = screenToWorld(sx, sy);
    const hit = hitTest(w.x, w.y);
    if (!hit || hit.locked) return;
    if (hit.type !== 'door' && hit.type !== 'window') return;
    e.preventDefault();
    pushHistory();
    flipOpening(hit);
    state.selectedId = hit.id;
    refreshAll();
  });

  function flipOpening(o) {
    // Move the origin to the current end point, then rotate 180° so the
    // opening ends back at the original origin.
    const rad = (o.rot || 0) * Math.PI / 180;
    o.x = o.x + Math.cos(rad) * o.w;
    o.y = o.y + Math.sin(rad) * o.w;
    o.rot = ((o.rot || 0) + 180) % 360;
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const before = screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    state.view.zoom = Math.max(0.1, Math.min(8, state.view.zoom * factor));
    const after = screenToWorld(sx, sy);
    const s = state.pxPerMeter * state.view.zoom;
    state.view.x += (after.x - before.x) * s;
    state.view.y += (after.y - before.y) * s;
    draw();
  }, { passive: false });

  // ---------- Toolbar ----------
  document.querySelectorAll('.tool').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.tool = btn.dataset.tool;
      setHint(toolHint(state.tool));
    });
  });

  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);
  document.getElementById('btn-delete').addEventListener('click', deleteSelected);

  document.getElementById('btn-zoom-in-bar').addEventListener('click', () => zoomBy(1.2));
  document.getElementById('btn-zoom-out-bar').addEventListener('click', () => zoomBy(1 / 1.2));
  document.getElementById('btn-zoom-reset-bar').addEventListener('click', resetView);

  // Generic dropdown wiring shared by Settings / Export / etc.
  // Toggles `panel.hidden`, mirrors `.open` on the wrapper, syncs aria,
  // and closes on outside click or Esc. Items inside the panel that have
  // `[data-close-on-click]` (set by default for `.dropdown-item`) close
  // the panel automatically when clicked.
  function bindDropdown(wrapId, btnId, panelId) {
    const wrap = document.getElementById(wrapId);
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (!wrap || !btn || !panel) return;
    const close = () => {
      panel.hidden = true;
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      panel.hidden = false;
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.hidden ? open() : close();
    });
    panel.addEventListener('click', (e) => {
      const item = e.target.closest('.dropdown-item');
      if (item) close();
    });
    document.addEventListener('mousedown', (e) => {
      if (panel.hidden) return;
      if (!wrap.contains(e.target)) close();
    }, true);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) close();
    });
  }

  bindDropdown('settings-dropdown', 'btn-settings', 'settings-panel');
  bindDropdown('file-dropdown', 'btn-file', 'file-panel');

  // Project name input \u2014 keep state in sync.
  (() => {
    const pn = document.getElementById('project-name');
    if (!pn) return;
    pn.value = state.projectName;
    sizeProjectNameInput();
    pn.addEventListener('input', () => {
      state.projectName = pn.value;
      sizeProjectNameInput();
      scheduleAutosave();
    });
    // Blur normalizes blank to placeholder default and renames the disk file
    // to match (when one is bound and the browser supports handle.move()).
    pn.addEventListener('blur', () => {
      if (!pn.value.trim()) {
        state.projectName = 'Untitled Layout';
        pn.value = state.projectName;
      }
      sizeProjectNameInput();
      scheduleAutosave();
      renameBoundFileToProject();
    });
    pn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); pn.blur(); }
    });
  })();

  // Cross-browser content-fit for the project-name input.
  // Chromium uses CSS `field-sizing: content`; Firefox / Safari fall back to
  // measuring the rendered text width here so the .json suffix sits flush.
  function sizeProjectNameInput() {
    const pn = document.getElementById('project-name');
    if (!pn) return;
    // Skip the JS sizing when the browser handles it natively.
    if (CSS && CSS.supports && CSS.supports('field-sizing', 'content')) return;
    const text = pn.value || pn.placeholder || '';
    const cs = window.getComputedStyle(pn);
    const c = sizeProjectNameInput._c
      || (sizeProjectNameInput._c = document.createElement('canvas').getContext('2d'));
    c.font = `${cs.fontStyle || 'normal'} ${cs.fontVariant || 'normal'} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = c.measureText(text).width;
    // Add a small caret allowance, clamp between min/max.
    pn.style.width = `${Math.max(48, Math.min(320, Math.ceil(w) + 6))}px`;
  }

  // Rename the bound file on disk so its name matches the project title.
  // Uses FileSystemFileHandle.move(newName) \u2014 Chromium 110+, same-directory
  // rename only. No-op when there's no bound file or the API is missing.
  async function renameBoundFileToProject() {
    if (!currentFile.handle || typeof currentFile.handle.move !== 'function') return;
    const m = currentFile.name && currentFile.name.match(/\.[^.]+$/);
    const ext = m ? m[0].replace(/^\./, '') : 'json';
    const desired = exportFilename(ext);
    if (desired === currentFile.name) return;
    try {
      const ok = await ensureWritePermission(currentFile.handle);
      if (!ok) return;
      await currentFile.handle.move(desired);
      currentFile.name = desired;
      persistHandle(currentFile.handle, desired, lastSavedAt || Date.now(), activeTabId);
      updateFileMeta();
      flash(`Renamed to ${desired}`);
    } catch (err) {
      console.warn('Could not rename file on disk', err);
      flash('Could not rename file on disk');
    }
  }

  // After opening a file, set the editable project title (and underlying
  // state) to match the file's base name so the on-disk name is the source
  // of truth. Strips the extension; falls back to existing project name if
  // the file name has no base.
  function syncProjectNameToFile(fileName) {
    if (!fileName) return;
    const base = fileName.replace(/\.[^.]+$/, '').trim();
    if (!base) return;
    state.projectName = base;
    const pn = document.getElementById('project-name');
    if (pn) pn.value = base;
    if (typeof sizeProjectNameInput === 'function') sizeProjectNameInput();
  }

  // ---------- Open / Save to a file on the user's computer ----------
  // Uses the File System Access API (Chromium) when available so subsequent
  // Saves write back to the same file without re-prompting. On other
  // browsers (Firefox/Safari) we fall back to a hidden <input type=file>
  // for Open and a download for Save / Save As.
  const hasFSAccess =
    typeof window !== 'undefined' &&
    'showOpenFilePicker' in window &&
    'showSaveFilePicker' in window;

  // Currently bound file (null until the user opens or saves one).
  // Currently bound file for the active tab. Reassigned on tab switch.
  let currentFile = { handle: null, name: null };

  const FILE_PICKER_TYPES = [{
    description: 'Khaaka Layout (JSON)',
    accept: { 'application/json': ['.json'] },
  }];

  // ---------- Persist the FileSystemFileHandle across reloads ----------
  // Handles are structured-cloneable so we can stash them in IndexedDB.
  // localStorage cannot hold them. On reload we restore { handle, name } but
  // permission must be re-granted on a user gesture (browser security rule).
  // Records are now keyed per tab id so multiple tabs persist independently.
  const HANDLE_DB = 'khaaka-fs';
  const HANDLE_STORE = 'handles';

  function openHandleDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(HANDLE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function persistHandle(handle, name, savedAt, tabId) {
    if (!hasFSAccess) return;
    const key = tabId || (activeTab() && activeTab().id) || 'currentFile';
    try {
      const db = await openHandleDb();
      await new Promise((res, rej) => {
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).put({ handle, name, savedAt: savedAt || Date.now() }, key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (err) {
      console.warn('Could not persist file handle', err);
    }
  }
  async function clearPersistedHandle(tabId) {
    const key = tabId || (activeTab() && activeTab().id) || 'currentFile';
    try {
      const db = await openHandleDb();
      await new Promise((res, rej) => {
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).delete(key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch { /* ignore */ }
  }
  async function loadPersistedHandle(tabId) {
    if (!hasFSAccess) return null;
    const key = tabId || 'currentFile';
    try {
      const db = await openHandleDb();
      const rec = await new Promise((res, rej) => {
        const tx = db.transaction(HANDLE_STORE, 'readonly');
        const r = tx.objectStore(HANDLE_STORE).get(key);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
      });
      db.close();
      return rec;
    } catch { return null; }
  }

  // ---------- Tabs (multi-document) ----------
  // Each tab owns: state, currentFile, lastSavedFileSnapshot, lastSavedAt.
  // The module-level `state` and `currentFile` always point at the active
  // tab so the rest of the app keeps working unchanged.
  const tabs = [];
  let activeTabId = null;
  function activeTab() {
    return tabs.find(t => t.id === activeTabId) || null;
  }
  function makeTabId() {
    return 't_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
  }
  function makeTab(opts = {}) {
    return {
      id: opts.id || makeTabId(),
      state: opts.state || makeBlankState(),
      currentFile: opts.currentFile || { handle: null, name: null },
      lastSavedFileSnapshot: opts.lastSavedFileSnapshot || null,
      lastSavedAt: opts.lastSavedAt || null,
    };
  }
  function snapshotActiveTab() {
    const t = activeTab();
    if (!t) return;
    t.state = state;
    t.currentFile = currentFile;
    t.lastSavedFileSnapshot = lastSavedFileSnapshot;
    t.lastSavedAt = lastSavedAt;
  }
  function hydrateTab(t) {
    state = t.state;
    currentFile = t.currentFile;
    lastSavedFileSnapshot = t.lastSavedFileSnapshot;
    lastSavedAt = t.lastSavedAt;
  }

  // Push the active tab's state into the UI (project name, units, grid
  // toggles, tool selection). Caller is responsible for the canvas redraw.
  function syncUIFromState() {
    const pn = document.getElementById('project-name');
    if (pn) pn.value = state.projectName;
    if (typeof sizeProjectNameInput === 'function') sizeProjectNameInput();
    const optGrid = document.getElementById('opt-grid');
    if (optGrid) optGrid.checked = !!state.grid.show;
    const optSnap = document.getElementById('opt-snap');
    if (optSnap) optSnap.checked = !!state.grid.snap;
    const optDims = document.getElementById('opt-dims');
    if (optDims) optDims.checked = !!state.showDims;
    const optUnits = document.getElementById('opt-units');
    if (optUnits) optUnits.value = state.units;
    const optBoxPx = document.getElementById('opt-box-px');
    if (optBoxPx) optBoxPx.value = String(state.pxPerBox);
    document.querySelectorAll('.tool[data-tool]').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === state.tool);
    });
    setHint(toolHint(state.tool));
    if (typeof refreshUnitLabels === 'function') refreshUnitLabels();
  }

  function switchToTab(id) {
    if (id === activeTabId) { renderTabStrip(); return; }
    snapshotActiveTab();
    const next = tabs.find(t => t.id === id);
    if (!next) return;
    activeTabId = id;
    hydrateTab(next);
    syncUIFromState();
    if (typeof refreshAll === 'function') refreshAll();
    updateFileMeta();
    if (typeof updateSaveButton === 'function') updateSaveButton();
    renderTabStrip();
    persistTabs();
  }

  function createTab(opts = {}) {
    snapshotActiveTab();
    const t = makeTab(opts);
    tabs.push(t);
    if (opts.activate !== false) {
      activeTabId = t.id;
      hydrateTab(t);
      syncUIFromState();
      if (typeof refreshAll === 'function') refreshAll();
      updateFileMeta();
      if (typeof updateSaveButton === 'function') updateSaveButton();
    }
    renderTabStrip();
    persistTabs();
    return t;
  }

  async function closeTab(id) {
    const i = tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    if (id === activeTabId) snapshotActiveTab();
    const t = tabs[i];
    const dirty = isTabDirty(t);
    if (dirty) {
      if (id !== activeTabId) switchToTab(id);
      const choice = await showModal({
        kind: 'confirm',
        title: 'Close this file?',
        message: `"${t.currentFile.name || (t.state.projectName + '.json')}" has unsaved changes. Save before closing, or discard them.`,
        okText: 'Save & close',
        extraText: 'Discard & close',
        cancelText: 'Cancel',
      });
      if (choice === false) return;     // Cancel / Esc / backdrop
      if (choice === true) {
        try {
          if (currentFile.handle) await saveToFile();
          else await saveAsToFile();
        } catch (err) {
          flash('Could not save — close cancelled');
          return;
        }
      }
    }
    clearPersistedHandle(t.id);
    const wasActive = id === activeTabId;
    tabs.splice(i, 1);
    if (wasActive) {
      const neighbor = tabs[i] || tabs[i - 1];
      if (neighbor) {
        activeTabId = neighbor.id;
        hydrateTab(neighbor);
      } else {
        const fresh = makeTab();
        tabs.push(fresh);
        activeTabId = fresh.id;
        hydrateTab(fresh);
      }
      syncUIFromState();
      refreshAll();
      updateFileMeta();
      updateSaveButton();
    }
    renderTabStrip();
    persistTabs();
  }

  // Stable serialization used for dirty checks and persistence.
  function serializeState(s) {
    return JSON.stringify({
      version: 1,
      pxPerMeter: s.pxPerMeter, pxPerBox: s.pxPerBox,
      grid: s.grid, showDims: s.showDims, units: s.units,
      defaultWallThickness: s.defaultWallThickness,
      projectName: s.projectName,
      view: s.view, objects: s.objects, nextId: s.nextId,
    }, null, 2);
  }
  function isTabDirty(t) {
    const s = (t.id === activeTabId) ? state : t.state;
    const cf = (t.id === activeTabId) ? currentFile : t.currentFile;
    const last = (t.id === activeTabId) ? lastSavedFileSnapshot : t.lastSavedFileSnapshot;
    if (!cf || !cf.name) return false;
    return serializeState(s) !== last;
  }

  function persistTabs() {
    if (READONLY) return;
    try {
      const list = tabs.map(t => {
        const s = (t.id === activeTabId) ? state : t.state;
        const cf = (t.id === activeTabId) ? currentFile : t.currentFile;
        return {
          id: t.id,
          fileName: cf && cf.name || null,
          snap: serializeState(s),
        };
      });
      localStorage.setItem(TABS_KEY, JSON.stringify(list));
      localStorage.setItem(ACTIVE_TAB_KEY, activeTabId || '');
    } catch (err) {
      console.warn('Could not persist tabs', err);
    }
  }

  // Restore tabs from localStorage + IDB. Returns true if at least one tab
  // was hydrated; false if there was nothing to restore.
  async function restoreTabs() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(TABS_KEY) || '[]'); } catch { list = []; }
    const activeStored = localStorage.getItem(ACTIVE_TAB_KEY) || '';
    if (list.length === 0) {
      // Migration from the legacy single-tab key.
      const legacy = localStorage.getItem(STORAGE_KEY);
      if (legacy) list = [{ id: makeTabId(), fileName: null, snap: legacy }];
    }
    if (list.length === 0) return false;

    for (const rec of list) {
      const t = makeTab({ id: rec.id });
      try {
        const d = JSON.parse(rec.snap);
        Object.assign(t.state, {
          objects: d.objects || [],
          nextId: d.nextId || (Math.max(0, ...((d.objects || []).map(o => o.id))) + 1),
          pxPerMeter: d.pxPerMeter || 40,
          pxPerBox: d.pxPerBox || 25,
          grid: d.grid || t.state.grid,
          showDims: d.showDims !== undefined ? d.showDims : true,
          units: (d.units === 'ft' || d.units === 'mm') ? d.units : 'm',
          defaultWallThickness: typeof d.defaultWallThickness === 'number' ? d.defaultWallThickness : t.state.defaultWallThickness,
          projectName: typeof d.projectName === 'string' && d.projectName.trim() ? d.projectName : t.state.projectName,
          view: d.view && typeof d.view.zoom === 'number' ? {
            x: typeof d.view.x === 'number' ? d.view.x : 0,
            y: typeof d.view.y === 'number' ? d.view.y : 0,
            zoom: Math.max(0.1, Math.min(8, d.view.zoom)),
          } : t.state.view,
        });
        t.lastSavedFileSnapshot = rec.snap;
      } catch (err) {
        console.warn('Could not restore tab snapshot', err);
      }
      // Re-attach the file handle (Chromium FS Access only).
      const handleRec = await loadPersistedHandle(t.id);
      if (handleRec && handleRec.handle) {
        t.currentFile = { handle: handleRec.handle, name: handleRec.name || rec.fileName || null };
        t.lastSavedAt = handleRec.savedAt || null;
      } else if (rec.fileName) {
        t.currentFile = { handle: null, name: rec.fileName };
      }
      tabs.push(t);
    }
    const activeRec = tabs.find(t => t.id === activeStored) || tabs[0];
    activeTabId = activeRec.id;
    hydrateTab(activeRec);
    return true;
  }

  function renderTabStrip() {
    const list = document.getElementById('tab-list');
    if (!list) return;
    list.innerHTML = '';
    for (const t of tabs) {
      const isActive = t.id === activeTabId;
      const cf = isActive ? currentFile : t.currentFile;
      const s = isActive ? state : t.state;
      const dirty = isTabDirty(t);
      const el = document.createElement('div');
      el.className = 'tab' + (isActive ? ' active' : '') + (dirty ? ' dirty' : '');
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(isActive));
      const label = cf.name || `${s.projectName || 'Untitled'}.json`;
      el.title = label;
      el.innerHTML =
        `<span class="tab-name">${escapeHtml(label)}</span>` +
        `<span class="tab-dirty" aria-hidden="true"></span>` +
        `<button class="tab-close" type="button" title="Close" aria-label="Close tab">` +
          `<svg class="ic"><use href="#i-x"/></svg>` +
        `</button>`;
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('.tab-close')) return;
        switchToTab(t.id);
      });
      el.querySelector('.tab-close').addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTab(t.id);
      });
      list.appendChild(el);
    }
  }

  function updateFileMeta() {
    const el = document.getElementById('file-name');
    if (el) {
      if (currentFile.name) {
        if (lastSavedAt) {
          el.innerHTML = `Saved at <span class="saved-at">${formatSavedAt(lastSavedAt)}</span>`;
        } else {
          el.textContent = 'Saved';
        }
        el.classList.add('has-file');
        el.title = currentFile.name + (lastSavedAt ? ` — saved ${new Date(lastSavedAt).toLocaleString()}` : '');
      } else {
        el.textContent = 'Unsaved';
        el.classList.remove('has-file');
        el.title = 'No file opened — use File ▸ Save File As… to save to disk';
      }
      // Reflect dirty state (compare current snapshot to last file save)
      const dirty = currentFile.name && lastSavedFileSnapshot !== serialize();
      el.classList.toggle('dirty', !!dirty);
    }
    // Mirror the bound file's extension on the editable title (default .json)
    const ext = document.getElementById('ext-suffix');
    if (ext) {
      const m = currentFile.name && currentFile.name.match(/\.[^.]+$/);
      ext.textContent = m ? m[0].toLowerCase() : '.json';
    }
    if (typeof updateSaveButton === 'function') updateSaveButton();
    // Keep tab dirty dots perfectly synced with the app-bar indicator.
    if (typeof renderTabStrip === 'function') renderTabStrip();
  }

  // Snapshot of the layout the last time it was successfully written to a file.
  let lastSavedFileSnapshot = null;
  // Epoch millis of the last successful disk save (persisted with the handle).
  let lastSavedAt = null;

  // "Saved as … at <time> (<relative>)"
  // Examples:
  //   "10:42 AM (3 sec ago)"
  //   "10:42 AM (5 min ago)"
  //   "yesterday at 10:42 AM"
  //   "May 10, 10:42 AM"
  function formatSavedAt(ts) {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return `${time} (${formatRelative(now - d)})`;

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate();
    if (isYesterday) return `yesterday at ${time}`;
    const datePart = d.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
    return `${datePart}, ${time}`;
  }

  function formatRelative(diffMs) {
    const sec = Math.max(0, Math.floor(diffMs / 1000));
    if (sec < 60) return `${sec} sec ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    return `${hr} hr ago`;
  }

  // Refresh the relative label every second so "3 sec ago" stays live.
  // Slows to 30s once it's older than a minute (no point updating per-second).
  setInterval(() => {
    if (!lastSavedAt || !currentFile.name) return;
    const ageSec = (Date.now() - lastSavedAt) / 1000;
    if (ageSec < 60) updateFileMeta();
    else if (ageSec < 3600 && Math.floor(ageSec) % 30 === 0) updateFileMeta();
  }, 1000);

  async function ensureWritePermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return true;
    const opts = { mode: 'readwrite' };
    let p = await handle.queryPermission(opts);
    if (p === 'granted') return true;
    p = await handle.requestPermission(opts);
    return p === 'granted';
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('Read failed'));
      r.readAsText(file);
    });
  }

  async function openFromFile() {
    // Always opens into a NEW tab. Current tab stays untouched.
    try {
      if (hasFSAccess) {
        let handle;
        try {
          [handle] = await window.showOpenFilePicker({
            types: FILE_PICKER_TYPES,
            excludeAcceptAllOption: false,
            multiple: false,
          });
        } catch (err) {
          if (err && err.name === 'AbortError') return; // user cancelled
          throw err;
        }
        const file = await handle.getFile();
        const text = await file.text();
        // Spawn a fresh tab and load into it.
        createTab();
        if (deserialize(text)) {
          currentFile.handle = handle;
          currentFile.name = file.name;
          syncProjectNameToFile(file.name);
          lastSavedFileSnapshot = serialize();
          lastSavedAt = (file.lastModified || Date.now());
          persistHandle(handle, file.name, lastSavedAt, activeTabId);
          updateFileMeta();
          renderTabStrip();
          persistTabs();
          flash(`Opened ${file.name}`);
        }
      } else {
        // Fallback: trigger the hidden file input
        document.getElementById('file-open-fallback').click();
      }
    } catch (err) {
      console.error(err);
      flash('Open failed');
    }
  }

  async function saveAsToFile() {
    try {
      if (hasFSAccess) {
        let handle;
        try {
          handle = await window.showSaveFilePicker({
            suggestedName: exportFilename('json'),
            types: FILE_PICKER_TYPES,
          });
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          throw err;
        }
        const text = serialize();
        const w = await handle.createWritable();
        await w.write(text);
        await w.close();
        currentFile.handle = handle;
        currentFile.name = handle.name || exportFilename('json');
        // The user may have typed a different name in the Save dialog —
        // sync the editable project title and tab label to match.
        syncProjectNameToFile(currentFile.name);
        // Re-serialize so the snapshot reflects the (possibly new) projectName.
        lastSavedFileSnapshot = serialize();
        lastSavedAt = Date.now();
        persistHandle(handle, currentFile.name, lastSavedAt, activeTabId);
        updateFileMeta();
        renderTabStrip();
        persistTabs();
        flash(`Saved to ${currentFile.name}`);
      } else {
        // Fallback: just trigger a download
        const name = exportFilename('json');
        download(name, serialize(), 'application/json');
        currentFile.handle = null;
        currentFile.name = name;
        syncProjectNameToFile(name);
        lastSavedFileSnapshot = serialize();
        lastSavedAt = Date.now();
        updateFileMeta();
        renderTabStrip();
        persistTabs();
        flash(`Downloaded ${name}`);
      }
    } catch (err) {
      console.error(err);
      flash('Save failed');
    }
  }

  async function saveToFile() {
    // No bound file yet → behave as Save As.
    if (!currentFile.handle) return saveAsToFile();
    try {
      const ok = await ensureWritePermission(currentFile.handle);
      if (!ok) {
        flash('Permission denied — choose a location');
        return saveAsToFile();
      }
      const text = serialize();
      const w = await currentFile.handle.createWritable();
      await w.write(text);
      await w.close();
      lastSavedFileSnapshot = text;
      lastSavedAt = Date.now();
      persistHandle(currentFile.handle, currentFile.name, lastSavedAt, activeTabId);
      updateFileMeta();
      flash(`Saved to ${currentFile.name}`);
    } catch (err) {
      console.error(err);
      // If the handle is no longer valid (file was moved/deleted) prompt for a new one.
      if (err && (err.name === 'NotFoundError' || err.name === 'NotAllowedError')) {
        currentFile.handle = null;
        return saveAsToFile();
      }
      flash('Save failed');
    }
  }

  document.getElementById('btn-open-file').addEventListener('click', openFromFile);
  document.getElementById('btn-save-file').addEventListener('click', saveToFile);
  document.getElementById('btn-save-as-file').addEventListener('click', saveAsToFile);
  document.getElementById('btn-export-png').addEventListener('click', exportPNG);
  document.getElementById('btn-save').addEventListener('click', () => {
    // No bound file → prompt user to choose a destination.
    // Otherwise just write back to the existing file.
    if (currentFile.handle || (!hasFSAccess && currentFile.name)) {
      saveToFile();
    } else {
      saveAsToFile();
    }
  });

  // Fallback open input (used on browsers without File System Access API)
  document.getElementById('file-open-fallback').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      // Open into a new tab.
      createTab();
      if (deserialize(text)) {
        currentFile.handle = null;       // no handle on fallback
        currentFile.name = file.name;
        syncProjectNameToFile(file.name);
        lastSavedFileSnapshot = serialize();
        lastSavedAt = (file.lastModified || Date.now());
        updateFileMeta();
        renderTabStrip();
        persistTabs();
        flash(`Opened ${file.name}`);
      }
    } catch (err) {
      flash('Open failed');
    }
  });

  // "+" button on the tab strip → blank new tab.
  document.getElementById('tab-add').addEventListener('click', () => {
    createTab();
  });

  // Canvas option inputs
  document.getElementById('opt-units').addEventListener('change', (e) => {
    const u = e.target.value;
    state.units = (u === 'ft' || u === 'mm') ? u : 'm';
    // Reset to the canonical default box size for the chosen unit system
    // (1' for feet/inches, 25 cm for meters, 250 mm for millimeters) instead
    // of converting the previous value to the nearest option.
    state.grid.size = state.units === 'ft' ? ftToM(1) : 0.25;
    applyPxPerBox();
    refreshUnitLabels();
    refreshAll();
  });
  document.getElementById('opt-grid').addEventListener('change', (e) => { state.grid.show = e.target.checked; draw(); scheduleAutosave(); });
  document.getElementById('opt-snap').addEventListener('change', (e) => { state.grid.snap = e.target.checked; scheduleAutosave(); });
  document.getElementById('opt-dims').addEventListener('change', (e) => { state.showDims = e.target.checked; draw(); scheduleAutosave(); });
  document.getElementById('opt-grid-size').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) {
      state.grid.size = unitToM(v);
      applyPxPerBox();
      draw();
      scheduleAutosave();
    }
  });
  document.getElementById('opt-box-px').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) {
      state.pxPerBox = v;
      applyPxPerBox();
      draw();
      scheduleAutosave();
    }
  });

  function refreshUnitLabels() {
    document.getElementById('opt-grid-size-label').textContent =
      `Box size (${state.units === 'ft' ? 'ft' : state.units === 'mm' ? 'mm' : 'm'})`;
    populateGridSizeOptions();
  }

  // Build the Box-size dropdown options based on current units, and select
  // the option closest to the current grid.size.
  function populateGridSizeOptions() {
    const sel = document.getElementById('opt-grid-size');
    if (!sel) return;
    const opts = state.units === 'ft'
      ? [
          { v: 0.5, label: '6"' },
          { v: 1,   label: '1\'' },
          { v: 2,   label: '2\'' },
          { v: 5,   label: '5\'' },
          { v: 10,  label: '10\'' },
        ]
      : state.units === 'mm'
      ? [
          { v: 10,   label: '10 mm' },
          { v: 25,   label: '25 mm' },
          { v: 50,   label: '50 mm' },
          { v: 100,  label: '100 mm' },
          { v: 250,  label: '250 mm' },
          { v: 500,  label: '500 mm' },
          { v: 1000, label: '1000 mm' },
        ]
      : [
          { v: 0.1, label: '10 cm' },
          { v: 0.25, label: '25 cm' },
          { v: 0.5, label: '50 cm' },
          { v: 1,   label: '1 m' },
          { v: 2,   label: '2 m' },
          { v: 5,   label: '5 m' },
        ];
    sel.innerHTML = '';
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = String(o.v);
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    // Pick option whose value (in current units) is closest to current grid.size (meters)
    const currentInUnits = mToUnit(state.grid.size);
    let best = opts[0], bestDiff = Infinity;
    for (const o of opts) {
      const d = Math.abs(o.v - currentInUnits);
      if (d < bestDiff) { best = o; bestDiff = d; }
    }
    sel.value = String(best.v);
    // Snap stored grid size to the chosen option (so dimensions/snapping match)
    state.grid.size = unitToM(best.v);
    applyPxPerBox();
  }

  // Keep one grid box rendered at exactly state.pxPerBox screen pixels by
  // deriving pxPerMeter from the grid size.
  function applyPxPerBox() {
    if (!state.pxPerBox || state.grid.size <= 0) return;
    state.pxPerMeter = state.pxPerBox / state.grid.size;
  }

  // Keyboard
  window.addEventListener('keydown', (e) => {
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    // View mode keeps the view controls and nothing else.
    if (e.key === 'Escape' && openNoteId !== null) { closeNoteCard(); return; }
    if (READONLY) {
      if (e.key === '+' || e.key === '=') zoomBy(1.2);
      else if (e.key === '-') zoomBy(1 / 1.2);
      else if (e.key === '0') resetView();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      // Ctrl/Cmd+Shift+Z is the standard redo on macOS and in most editors.
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (k === 'y') { e.preventDefault(); redo(); return; }
      if (k === 'o') { e.preventDefault(); openFromFile(); return; }
      if (k === 's') {
        e.preventDefault();
        if (e.shiftKey) { saveAsToFile(); return; }
        // If a file is currently bound, Ctrl+S writes back to it; otherwise
        // open the Save File dialog so the user can pick a destination.
        if (currentFile.handle || (!hasFSAccess && currentFile.name)) {
          saveToFile();
        } else {
          saveAsToFile();
        }
        return;
      }
      if (k === 'n') { e.preventDefault(); createTab(); return; }
      if (k === 't') { e.preventDefault(); createTab(); return; }
      if (k === 'w') { e.preventDefault(); if (activeTabId) closeTab(activeTabId); return; }
      if (k === 'a') { e.preventDefault(); selectAll(); return; }
      if (k === 'c') { e.preventDefault(); copySelection(); return; }
      if (k === 'x') { e.preventDefault(); cutSelection(); return; }
      if (k === 'v') { e.preventDefault(); pasteClipboard(); return; }
      if (k === 'd') { e.preventDefault(); duplicateSelection(); return; }
    }
    const map = { h: 'select', v: 'marquee', r: 'room', p: 'polygon', w: 'wall', d: 'door', n: 'window', t: 'text', m: 'measure', l: 'ruler',
                  s: 'socket', k: 'switch', b: 'light', g: 'gas', u: 'water', j: 'drain',
                  a: 'note' };
    // Polygon drafting captures Enter / Esc / Backspace before the global handlers.
    if (drag && drag.mode === 'polygon-draft') {
      if (e.key === 'Enter') { e.preventDefault(); finalizePolygonDraft(); return; }
      if (e.key === 'Escape') { e.preventDefault(); cancelPolygonDraft(); return; }
      if (e.key === 'Backspace') {
        e.preventDefault();
        const o = drag.obj;
        if (o.points.length > 1) { o.points.pop(); draw(); }
        else cancelPolygonDraft();
        return;
      }
    }
    if (map[e.key.toLowerCase()]) {
      const tool = map[e.key.toLowerCase()];
      const btn = document.querySelector(`.tool[data-tool="${tool}"]`);
      if (btn) btn.click();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      deleteSelected();
    } else if (e.key === 'Escape') {
      ensureSelection();
      if (state.selectedIds.size > 0) { clearSelection(); refreshAll(); }
    } else if (e.key === 'F2') {
      e.preventDefault();
      renameSelected();
    } else if (e.key === '+' || e.key === '=') { zoomBy(1.2); }
    else if (e.key === '-') { zoomBy(1 / 1.2); }
    else if (e.key === '0') { resetView(); }
  });

  // Start inline rename on the selected object via the Layers panel.
  // Switches to the object's layer category tab if needed so the row exists,
  // then triggers the same rename UI used by double-click.
  function renameSelected() {
    if (state.selectedId == null) { flash('Select an object first'); return; }
    const o = state.objects.find(x => x.id === state.selectedId);
    if (!o) return;
    if (o.type === 'measure') { flash('Measurements have no name'); return; }
    // Switch to the matching tab so the row gets rendered
    if (activeLayerTab !== o.type) {
      activeLayerTab = o.type;
      refreshLayers();
    }
    // Find the row and trigger its double-click rename
    const li = document.querySelector(`#layer-list li.layer-item[data-id="${o.id}"]`);
    if (!li) return;
    const nameSpan = li.querySelector('.layer-name');
    if (!nameSpan) return;
    startInlineRename(li, nameSpan, o);
  }

  function deleteSelected() {
    ensureSelection();
    if (state.selectedIds.size === 0) return;
    const targets = state.objects.filter(o => state.selectedIds.has(o.id) && !o.locked);
    if (targets.length === 0) { flash('Selection is locked'); return; }
    pushHistory();
    const ids = new Set(targets.map(o => o.id));
    state.objects = state.objects.filter(o => !ids.has(o.id));
    clearSelection();
    refreshAll();
  }

  function zoomBy(f) {
    const r = canvas.getBoundingClientRect();
    const sx = r.width / 2, sy = r.height / 2;
    const before = screenToWorld(sx, sy);
    state.view.zoom = Math.max(0.1, Math.min(8, state.view.zoom * f));
    const after = screenToWorld(sx, sy);
    const s = state.pxPerMeter * state.view.zoom;
    state.view.x += (after.x - before.x) * s;
    state.view.y += (after.y - before.y) * s;
    draw();
  }

  function resetView() {
    state.view = { x: 60, y: 60, zoom: 1 };
    draw();
  }

  // Zoom and centre so everything drawn fits on screen.
  function fitToContent() {
    const boxes = state.objects.map(getBounds).filter(b => b && b.w > 0);
    if (!boxes.length) return;
    const x = Math.min(...boxes.map(b => b.x));
    const y = Math.min(...boxes.map(b => b.y));
    const w = Math.max(...boxes.map(b => b.x + b.w)) - x;
    const h = Math.max(...boxes.map(b => b.y + b.h)) - y;
    const r = canvas.getBoundingClientRect();
    if (!r.width || w <= 0 || h <= 0) return;
    const pad = 48;
    const z = Math.min((r.width - pad * 2) / (w * state.pxPerMeter),
                       (r.height - pad * 2) / (h * state.pxPerMeter));
    state.view.zoom = Math.max(0.05, Math.min(8, z));
    const s = state.pxPerMeter * state.view.zoom;
    state.view.x = (r.width - w * s) / 2 - x * s;
    state.view.y = (r.height - h * s) / 2 - y * s;
    draw();
  }

  // ---------- Properties / Layers ----------
  // The Properties panel was removed - all editing flows through the
  // right-click context menu, the Layers panel, and direct canvas
  // manipulation. `refreshProps` is kept as a no-op so existing call
  // sites (mouse/keyboard handlers, undo/redo, etc.) do not change.
  function refreshProps() {}

  // Layer category metadata + active tab
  const LAYER_CATEGORIES = [
    { key: 'room',    label: 'Rooms',        icon: 'i-cat-room' },
    { key: 'polygon', label: 'Polygons',     icon: 'i-cat-polygon' },
    { key: 'wall',    label: 'Walls',        icon: 'i-cat-wall' },
    { key: 'door',    label: 'Doors',        icon: 'i-cat-door' },
    { key: 'window',  label: 'Windows',      icon: 'i-cat-window' },
    { key: 'text',    label: 'Text',         icon: 'i-cat-text' },
    { key: 'measure', label: 'Measurements', icon: 'i-cat-measure' },
    { key: 'ruler',   label: 'Rulers',        icon: 'i-cat-ruler' },
    { key: 'fixture', label: 'Services',      icon: 'i-cat-fixture' },
    { key: 'note',    label: 'Notes',         icon: 'i-cat-note' },
  ];
  let activeLayerTab = 'room';
  const layerTabs = document.getElementById('layer-tabs');

  function refreshLayers() {
    // Bucket objects by type, preserving array order (high-z first).
    const buckets = new Map();
    for (const cat of LAYER_CATEGORIES) buckets.set(cat.key, []);
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (buckets.has(o.type)) buckets.get(o.type).push(o);
    }

    // Hide the entire Layers card when the layout has no objects at all.
    const layersCard = document.getElementById('layers-card');
    if (layersCard) layersCard.hidden = state.objects.length === 0;
    if (state.objects.length === 0) {
      if (layerTabs) layerTabs.innerHTML = '';
      if (layerList) layerList.innerHTML = '';
      return;
    }

    // ---- Tabs ----
    layerTabs.innerHTML = '';
    // If the current active tab has no items, fall back to the first tab that does.
    const activeHasItems = (buckets.get(activeLayerTab) || []).length > 0;
    if (!activeHasItems) {
      const firstWithItems = LAYER_CATEGORIES.find(c => (buckets.get(c.key) || []).length > 0);
      if (firstWithItems) activeLayerTab = firstWithItems.key;
    }
    for (const cat of LAYER_CATEGORIES) {
      const count = (buckets.get(cat.key) || []).length;
      // Hide empty type-tabs entirely
      if (count === 0) continue;
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'layer-tab' + (cat.key === activeLayerTab ? ' active' : '');
      tab.title = cat.label;
      tab.dataset.key = cat.key;
      tab.innerHTML =
        `<span class="tab-icon"><svg class="ic"><use href="#${cat.icon}"/></svg></span>` +
        `<span class="tab-label">${cat.label}</span>` +
        `<span class="tab-count">${count}</span>`;
      tab.addEventListener('click', () => {
        activeLayerTab = cat.key;
        refreshLayers();
      });
      layerTabs.appendChild(tab);
    }

    // ---- List ----
    layerList.innerHTML = '';
    const items = buckets.get(activeLayerTab) || [];
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'layer-empty';
      empty.textContent = 'No items.';
      layerList.appendChild(empty);
      return;
    }
    for (const o of items) {
      layerList.appendChild(buildLayerRow(o));
    }
  }

  function buildLayerRow(o) {
    const li = document.createElement('li');
    li.className = 'layer-item';
    li.dataset.id = String(o.id);
    li.draggable = true;
    if (o.id === state.selectedId) li.classList.add('selected');
    if (o.locked) li.classList.add('locked');

    const grip = document.createElement('span');
    grip.className = 'layer-grip';
    grip.title = 'Drag to reorder';
    grip.innerHTML = '<svg class="ic"><use href="#i-grip"/></svg>';
    li.appendChild(grip);

    const name = o.label || o.text || `${o.type} #${o.id}`;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'layer-name';
    nameSpan.title = 'Double-click to rename';
    nameSpan.textContent = name;
    nameSpan.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      startInlineRename(li, nameSpan, o);
    });
    li.appendChild(nameSpan);

    const actions = document.createElement('span');
    actions.className = 'layer-actions';

    const lock = document.createElement('button');
    lock.className = 'lock';
    lock.innerHTML = `<svg class="ic"><use href="#${o.locked ? 'i-lock' : 'i-unlock'}"/></svg>`;
    lock.title = o.locked ? 'Unlock' : 'Lock (prevents move/resize/delete)';
    lock.addEventListener('click', (ev) => {
      ev.stopPropagation();
      pushHistory();
      o.locked = !o.locked;
      refreshAll();
    });
    actions.appendChild(lock);

    const del = document.createElement('button');
    del.className = 'del';
    del.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
    del.title = o.locked ? 'Unlock first to delete' : 'Delete';
    del.disabled = !!o.locked;
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (o.locked) return;
      pushHistory();
      state.objects = state.objects.filter(x => x.id !== o.id);
      if (state.selectedId === o.id) state.selectedId = null;
      refreshAll();
    });
    actions.appendChild(del);

    li.appendChild(actions);
    li.addEventListener('click', () => {
      state.selectedId = o.id;
      refreshAll();
    });

    // ---- Drag and drop reordering (same-category only) ----
    li.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', String(o.id));
      ev.dataTransfer.setData('application/x-layer-type', o.type);
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      layerList.querySelectorAll('.drop-above, .drop-below')
        .forEach(el => el.classList.remove('drop-above', 'drop-below'));
    });
    li.addEventListener('dragover', (ev) => {
      const fromType = ev.dataTransfer.getData('application/x-layer-type');
      // Only allow drop within same category. (getData is empty in some
      // browsers during dragover; fall back to allowing the drop and
      // re-validating in the drop handler.)
      if (fromType && fromType !== o.type) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      const rect = li.getBoundingClientRect();
      const before = (ev.clientY - rect.top) < rect.height / 2;
      li.classList.toggle('drop-above', before);
      li.classList.toggle('drop-below', !before);
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('drop-above', 'drop-below');
    });
    li.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const fromId = parseInt(ev.dataTransfer.getData('text/plain'), 10);
      if (isNaN(fromId) || fromId === o.id) return;
      const fromObj = state.objects.find(x => x.id === fromId);
      if (!fromObj || fromObj.type !== o.type) return; // category guard
      const rect = li.getBoundingClientRect();
      const before = (ev.clientY - rect.top) < rect.height / 2;
      reorderLayers(fromId, o.id, before);
    });

    return li;
  }

  // Reorder objects so that `fromId` is dropped just above (`before` = true)
  // or just below the target id, in the **layers list** (which renders
  // top -> bottom from highest z to lowest).
  function reorderLayers(fromId, targetId, before) {
    const fromIdx = state.objects.findIndex(x => x.id === fromId);
    const targetIdx = state.objects.findIndex(x => x.id === targetId);
    if (fromIdx < 0 || targetIdx < 0 || fromIdx === targetIdx) return;
    pushHistory();
    const [item] = state.objects.splice(fromIdx, 1);
    // Recompute target index after removal.
    let tIdx = state.objects.findIndex(x => x.id === targetId);
    // List is reversed visually: dropping ABOVE in the UI = HIGHER z = AFTER target in array.
    let insertAt = before ? tIdx + 1 : tIdx;
    if (insertAt < 0) insertAt = 0;
    if (insertAt > state.objects.length) insertAt = state.objects.length;
    state.objects.splice(insertAt, 0, item);
    refreshAll();
  }

  function startInlineRename(li, nameSpan, o) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'layer-rename';
    input.value = o.label || o.text || '';
    nameSpan.replaceWith(input);
    input.focus();
    input.select();
    let cancelled = false;
    let committed = false;
    const commit = () => {
      if (committed || cancelled) return;
      committed = true;
      const v = input.value.trim();
      const oldName = o.label || o.text || '';
      if (v === oldName) { refreshAll(); return; }
      pushHistory();
      if (o.type === 'text') o.text = v || 'Text';
      else o.label = v;
      refreshAll();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancelled = true; refreshAll(); }
    });
    input.addEventListener('blur', commit);
  }

  function refreshAll() {
    refreshProps();
    refreshLayers();
    refreshSidePanel();
    draw();
    scheduleAutosave();
  }

  // Hide the entire right-side panel when there are no objects (Layers card
  // is empty). Properties card was removed; only Layers lives here now.
  function refreshSidePanel() {
    const aside = document.querySelector('aside.properties');
    const layersCard = document.getElementById('layers-card');
    if (!aside) return;
    aside.hidden = !(layersCard && !layersCard.hidden);
  }

  // ---------- Autosave (debounced) ----------
  // Saves the current layout to localStorage shortly after any state change,
  // so the user never loses work if they close the tab. When a real file is
  // bound (File ▸ Open / Save As), also write that file silently.
  let autosaveTimer = null;
  let suppressAutosave = false;   // true while loading, to avoid feedback loops
  function scheduleAutosave() {
    if (READONLY) return;   // a viewer must never write back
    if (suppressAutosave) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(doAutosave, 400);
  }
  function doAutosave() {
    autosaveTimer = null;
    try {
      const snap = serialize();
      localStorage.setItem(STORAGE_KEY, snap);  // legacy mirror
      lastSavedSnapshot = snap;
    } catch (err) {
      // Storage may be full or unavailable (private mode, quota, etc.)
      flash('Auto-save failed');
    }
    // Mirror to disk when a file handle is bound.
    if (currentFile.handle) autosaveToDisk();
    updateFileMeta();
    updateSaveButton();
    // Multi-tab: persist all tab snapshots + dirty state on the strip.
    persistTabs();
    renderTabStrip();
  }

  // Coalescing disk-writer: at most one in-flight write at a time. If new
  // changes arrive mid-write, queue exactly one follow-up write.
  let diskWriteInFlight = false;
  let diskWritePending = false;
  async function autosaveToDisk() {
    if (!currentFile.handle) return;
    if (diskWriteInFlight) { diskWritePending = true; return; }
    diskWriteInFlight = true;
    try {
      const text = serialize();
      const ok = await ensureWritePermission(currentFile.handle);
      if (!ok) { diskWriteInFlight = false; return; }
      const w = await currentFile.handle.createWritable();
      await w.write(text);
      await w.close();
      lastSavedFileSnapshot = text;
      lastSavedAt = Date.now();
      persistHandle(currentFile.handle, currentFile.name, lastSavedAt, activeTabId);
      updateFileMeta();
      updateSaveButton();
    } catch (err) {
      console.warn('Disk autosave failed', err);
      // If the handle vanished (file was moved/deleted), drop it so the user
      // is prompted to choose a new location on the next manual save.
      if (err && (err.name === 'NotFoundError' || err.name === 'NotAllowedError')) {
        currentFile.handle = null;
        currentFile.name = null;
        lastSavedFileSnapshot = null;
        lastSavedAt = null;
        clearPersistedHandle(activeTabId);
        updateFileMeta();
        updateSaveButton();
        flash('File no longer accessible — Save again to pick a new location');
      }
    } finally {
      diskWriteInFlight = false;
      if (diskWritePending) {
        diskWritePending = false;
        // Run the queued follow-up after current micro-task settles.
        Promise.resolve().then(autosaveToDisk);
      }
    }
  }

  // Heartbeat: every second, re-write the bound file even if nothing changed.
  // Touches the file's modification time and refreshes "Saved at <time>".
  // The coalescing guard above ensures we never have overlapping writes.
  setInterval(() => {
    if (currentFile.handle && !suppressAutosave) autosaveToDisk();
  }, 1000);

  // Save-button state. Behaviour:
  //  • No file bound  → enabled "Save" → opens Save As dialog
  //  • File bound + on-disk in sync → disabled "Saved"
  //  • File bound + autosave in flight → still shows "Saved" (silent autosave;
  //    avoids flicker between Saved → Saving… → Saved on every edit)
  function updateSaveButton() {
    const btn = document.getElementById('btn-save');
    if (!btn) return;
    const labelEl = btn.querySelector('span');
    const hasFile = !!currentFile.handle || (!hasFSAccess && !!currentFile.name);
    const inSync = hasFile && lastSavedFileSnapshot === serialize();
    const saving = diskWriteInFlight || diskWritePending;

    let label, disabled, title;
    if (!hasFile) {
      label = 'Save'; disabled = false; title = 'Save to file (Ctrl+S)';
    } else if (inSync || saving) {
      // Treat in-flight autosave as already saved — the bytes are on the way
      // and the user shouldn't see a busy state for routine edits.
      label = 'Saved'; disabled = true; title = 'All changes saved to file';
    } else {
      label = 'Save'; disabled = false; title = 'Save to file (Ctrl+S)';
    }
    btn.disabled = disabled;
    btn.classList.toggle('is-saved', disabled && hasFile);
    if (labelEl) labelEl.textContent = label;
    btn.title = title;
  }

  // Track snapshot of the last successful localStorage save (used by
  // updateFileMeta dirty comparison).
  let lastSavedSnapshot = null;
  // Best-effort flush before leaving the page
  window.addEventListener('beforeunload', (e) => {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      try { localStorage.setItem(STORAGE_KEY, serialize()); } catch {}
      // Disk write is async and may not finish before unload; warn the user
      // if there are unsaved changes to a bound file.
      if (currentFile.handle && lastSavedFileSnapshot !== serialize()) {
        e.preventDefault();
        e.returnValue = '';
      }
    } else if (currentFile.handle && lastSavedFileSnapshot !== serialize()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function toHex(c) {
    if (!c) return '#000000';
    if (c.startsWith('#')) return c.length === 7 ? c : '#000000';
    // basic rgb -> hex
    const m = c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) return '#' + [1,2,3].map(i => parseInt(m[i]).toString(16).padStart(2,'0')).join('');
    return '#000000';
  }

  // ---------- Persistence ----------
  function serialize() {
    // Delegate to the per-tab serializer so app-bar dirty and tab dirty
    // compare against byte-identical snapshots.
    return serializeState(state);
  }
  function deserialize(s) {
    try {
      const d = JSON.parse(s);
      pushHistory();
      suppressAutosave = true;
      state.pxPerMeter = d.pxPerMeter || 40;
      state.pxPerBox = d.pxPerBox || 25;
      state.grid = d.grid || state.grid;
      state.showDims = d.showDims !== undefined ? d.showDims : true;
      state.units = (d.units === 'ft' || d.units === 'mm') ? d.units : 'm';
      if (typeof d.defaultWallThickness === 'number') state.defaultWallThickness = d.defaultWallThickness;
      if (typeof d.projectName === 'string' && d.projectName.trim()) state.projectName = d.projectName;
      if (d.view && typeof d.view.zoom === 'number') {
        state.view = {
          x: typeof d.view.x === 'number' ? d.view.x : state.view.x,
          y: typeof d.view.y === 'number' ? d.view.y : state.view.y,
          zoom: Math.max(0.1, Math.min(8, d.view.zoom)),
        };
      }
      state.objects = d.objects || [];
      state.nextId = d.nextId || (Math.max(0, ...state.objects.map(o => o.id)) + 1);
      state.selectedId = null;
      // Reflect in UI
      document.getElementById('opt-grid').checked = !!state.grid.show;
      document.getElementById('opt-snap').checked = !!state.grid.snap;
      document.getElementById('opt-dims').checked = !!state.showDims;
      document.getElementById('opt-units').value = state.units;
      document.getElementById('opt-box-px').value = String(state.pxPerBox);
      const pn = document.getElementById('project-name');
      if (pn) pn.value = state.projectName;
      refreshUnitLabels();
      refreshAll();
      suppressAutosave = false;
      return true;
    } catch (err) {
      suppressAutosave = false;
      showModal({
        kind: 'alert',
        title: 'Could not load layout',
        message: err.message,
      });
      return false;
    }
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Build a safe export filename from the project name.
  // Returns e.g. "My Plot.json". The user can rename in the save dialog.
  function exportFilename(ext) {
    const raw = (state.projectName || 'Untitled Layout').trim() || 'Untitled Layout';
    // Strip characters that are invalid in filenames on Windows/macOS/Linux.
    const safe = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').slice(0, 60).trim() || 'Untitled Layout';
    return `${safe}.${ext}`;
  }
  function exportPNG() {
    // Render a clean copy without selection halo or status overlays.
    const wasSelected = state.selectedId;
    state.selectedId = null;
    draw();
    const off = document.createElement('canvas');
    const r = canvas.getBoundingClientRect();
    const scale = 2;
    off.width = r.width * scale;
    off.height = r.height * scale;
    const octx = off.getContext('2d');
    octx.drawImage(canvas, 0, 0, off.width, off.height);
    off.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = exportFilename('png');
      a.click();
      URL.revokeObjectURL(a.href);
    });
    state.selectedId = wasSelected;
    draw();
  }

  function flash(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    // Force reflow so the .show transition replays even on rapid successive flashes.
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(flash._timer);
    flash._timer = setTimeout(() => {
      t.classList.remove('show');
      // Hide after the transition completes
      setTimeout(() => { if (!t.classList.contains('show')) t.hidden = true; }, 200);
    }, 1600);
  }

  // ---------- Modal dialog (custom alert / confirm / prompt) ----------
  // Returns a Promise resolving to:
  //   - alert:   true / false  (always true once dismissed; hitting Esc/cancel returns false)
  //   - confirm: true / false  (true on OK, false on Cancel/Esc)
  //   - prompt:  string / null (null on Cancel/Esc, string on OK)
  // opts: { title, message, kind: 'alert'|'confirm'|'prompt', okText, cancelText,
  //         danger, defaultValue, placeholder }
  function showModal(opts = {}) {
    const backdrop = document.getElementById('modal-backdrop');
    const titleEl = document.getElementById('modal-title');
    const msgEl   = document.getElementById('modal-message');
    const inputEl = document.getElementById('modal-input');
    const okBtn   = document.getElementById('modal-ok');
    const cancelBtn = document.getElementById('modal-cancel');
    if (!backdrop) return Promise.resolve(false);

    const kind = opts.kind || 'alert';
    titleEl.textContent = opts.title || '';
    msgEl.textContent = opts.message || '';
    okBtn.textContent = opts.okText || (kind === 'alert' ? 'OK' : (kind === 'confirm' ? 'Confirm' : 'OK'));
    cancelBtn.textContent = opts.cancelText || 'Cancel';
    cancelBtn.hidden = (kind === 'alert');
    okBtn.classList.toggle('danger', !!opts.danger);

    // Optional middle button (e.g. "Discard & open"). Inserted between
    // Cancel and OK; resolves the promise with the string 'extra'.
    let extraBtn = document.getElementById('modal-extra');
    if (opts.extraText) {
      if (!extraBtn) {
        extraBtn = document.createElement('button');
        extraBtn.id = 'modal-extra';
        extraBtn.type = 'button';
        extraBtn.className = 'modal-btn modal-btn-ghost';
        cancelBtn.parentNode.insertBefore(extraBtn, okBtn);
      }
      extraBtn.textContent = opts.extraText;
      extraBtn.hidden = false;
    } else if (extraBtn) {
      extraBtn.hidden = true;
    }

    if (kind === 'prompt') {
      inputEl.hidden = false;
      inputEl.value = opts.defaultValue ?? '';
      inputEl.placeholder = opts.placeholder || '';
    } else {
      inputEl.hidden = true;
      inputEl.value = '';
    }

    backdrop.hidden = false;
    backdrop.setAttribute('aria-hidden', 'false');

    return new Promise(resolve => {
      const close = (result) => {
        backdrop.hidden = true;
        backdrop.setAttribute('aria-hidden', 'true');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        if (extraBtn) extraBtn.removeEventListener('click', onExtra);
        backdrop.removeEventListener('mousedown', onBackdrop);
        document.removeEventListener('keydown', onKey, true);
        resolve(result);
      };
      const onOk = () => {
        if (kind === 'prompt') close(inputEl.value);
        else if (kind === 'confirm') close(true);
        else close(true);
      };
      const onCancel = () => {
        if (kind === 'prompt') close(null);
        else close(false);
      };
      const onExtra = () => close('extra');
      const onBackdrop = (e) => { if (e.target === backdrop) onCancel(); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        else if (e.key === 'Enter' && document.activeElement !== cancelBtn) {
          // Allow Enter to confirm; in a prompt this also captures input value
          e.preventDefault(); e.stopPropagation(); onOk();
        }
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      if (extraBtn && opts.extraText) extraBtn.addEventListener('click', onExtra);
      backdrop.addEventListener('mousedown', onBackdrop);
      document.addEventListener('keydown', onKey, true);
      // Focus management
      setTimeout(() => {
        if (kind === 'prompt') { inputEl.focus(); inputEl.select(); }
        else okBtn.focus();
      }, 0);
    });
  }

  // Collapsible side-panel cards (Properties / Canvas / Layers).
  // Persists per-card collapsed state in localStorage.
  const COLLAPSE_KEY = 'plotly.cards.collapsed.v1';
  function loadCollapsedSet() {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (!raw) return new Set();
      return new Set(JSON.parse(raw));
    } catch { return new Set(); }
  }
  function saveCollapsedSet(set) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch {}
  }
  function initCollapsibleCards() {
    const collapsed = loadCollapsedSet();
    document.querySelectorAll('.card.collapsible').forEach(card => {
      const key = card.dataset.card;
      const head = card.querySelector('.card-head');
      const setState = (isCollapsed) => {
        card.classList.toggle('collapsed', isCollapsed);
        if (head) head.setAttribute('aria-expanded', String(!isCollapsed));
      };
      setState(collapsed.has(key));
      if (head) {
        head.addEventListener('click', () => {
          const nowCollapsed = !card.classList.contains('collapsed');
          setState(nowCollapsed);
          if (nowCollapsed) collapsed.add(key); else collapsed.delete(key);
          saveCollapsedSet(collapsed);
        });
      }
    });
  }

  // ---------- Custom tooltip controller ----------
  // Hijacks any element's `title` attribute and shows it as a polished
  // floating tooltip instead of the native browser one. The native title
  // is removed on hover (kept in `data-tip-cache` so it can be restored).
  // Anything with `data-tip="..."` works too \u2014 useful for elements where
  // the native title would interfere (e.g. screen reader labels).
  (() => {
    const tip = document.getElementById('tooltip');
    if (!tip) return;
    let target = null;
    let showTimer = null;
    const SHOW_DELAY = 280;   // ms before showing
    const SAFETY = 6;         // viewport edge padding
    const GAP = 8;            // distance from target

    const getTipText = (el) => {
      if (!el) return '';
      const cached = el.getAttribute('data-tip') || el.getAttribute('data-tip-cache');
      if (cached) return cached;
      const t = el.getAttribute('title');
      if (!t) return '';
      // Move title into our cache so the browser doesn't show its own.
      el.setAttribute('data-tip-cache', t);
      el.removeAttribute('title');
      return t;
    };

    // Render the text \u2014 promotes "(Ctrl+S)" / "(Del)" suffixes into a kbd chip.
    const renderText = (text) => {
      const m = text.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
      if (!m) { tip.textContent = text; return; }
      tip.textContent = '';
      tip.append(m[1].trim());
      const k = document.createElement('kbd');
      k.textContent = m[2].trim();
      tip.appendChild(k);
    };

    const place = (el) => {
      const r = el.getBoundingClientRect();
      // Default: above. Flip below if not enough room above.
      tip.removeAttribute('hidden');
      // Force layout so we can measure
      tip.style.left = '0px';
      tip.style.top = '0px';
      const tr = tip.getBoundingClientRect();
      let dir = 'above';
      let top = r.top - tr.height - GAP;
      if (top < SAFETY) {
        dir = 'below';
        top = r.bottom + GAP;
      }
      let left = r.left + r.width / 2 - tr.width / 2;
      // Clamp horizontally
      if (left < SAFETY) left = SAFETY;
      else if (left + tr.width > window.innerWidth - SAFETY) left = window.innerWidth - tr.width - SAFETY;
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top  = `${Math.round(top)}px`;
      tip.setAttribute('data-dir', dir);
      // Position the arrow: keep it pointing at target's center
      const arrowX = (r.left + r.width / 2) - left;
      tip.style.setProperty('--tip-arrow-x', `${arrowX}px`);
      // Hide arrow if target is off-screen / too narrow to point cleanly
      tip.classList.toggle('no-arrow', r.width < 12 || r.height < 12);
    };

    const show = (el) => {
      const text = getTipText(el);
      if (!text) return;
      renderText(text);
      tip.hidden = false;
      tip.setAttribute('aria-hidden', 'false');
      place(el);
      // Trigger the entrance transition on the next frame
      requestAnimationFrame(() => tip.classList.add('show'));
      target = el;
    };

    const hide = () => {
      clearTimeout(showTimer);
      showTimer = null;
      tip.classList.remove('show');
      // Wait for fade-out before fully hiding
      setTimeout(() => {
        if (!tip.classList.contains('show')) {
          tip.hidden = true;
          tip.setAttribute('aria-hidden', 'true');
        }
      }, 120);
      target = null;
    };

    const findTarget = (el) => {
      while (el && el !== document.body) {
        if (el.nodeType === 1 && (el.hasAttribute('title') || el.hasAttribute('data-tip') || el.hasAttribute('data-tip-cache'))) {
          // Skip elements with empty tip text
          const text = el.getAttribute('data-tip') || el.getAttribute('data-tip-cache') || el.getAttribute('title');
          if (text && text.trim()) return el;
        }
        el = el.parentElement;
      }
      return null;
    };

    document.addEventListener('mouseover', (e) => {
      const el = findTarget(e.target);
      if (!el || el === target) return;
      // Cancel any pending show
      clearTimeout(showTimer);
      // If a tooltip is already showing, swap immediately
      if (target) hide();
      showTimer = setTimeout(() => show(el), SHOW_DELAY);
    });
    document.addEventListener('mouseout', (e) => {
      const to = e.relatedTarget;
      if (to && (tip.contains(to) || (target && target.contains(to)))) return;
      hide();
    });
    // Hide on user interactions that should reset hover state
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    window.addEventListener('blur', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
  })();

  // ---------- Init ----------
  window.addEventListener('resize', resizeCanvas);
  // Redraw the canvas whenever its element resizes (e.g. the right side
  // panel hides/shows and the grid column collapses).
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resizeCanvas).observe(canvas);
  }
  resetView();
  resizeCanvas();
  refreshUnitLabels();
  initCollapsibleCards();

  // ---------- Multi-tab bootstrap ----------
  // Restore the saved tab list (handles via IDB, snapshots via localStorage,
  // legacy single-tab key migrated automatically). If nothing to restore,
  // start with a single empty tab — clean slate, no demo content.
  (async () => {
    // View mode loads a published plan straight off the server and never
    // touches localStorage, so a visitor always sees the real thing.
    if (READONLY) {
      const file = new URLSearchParams(location.search).get('plan') || 'plan.json';
      try {
        const res = await fetch(file, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const t = makeTab();
        tabs.push(t);
        activeTabId = t.id;
        hydrateTab(t);
        deserialize(await res.text());
        state.projectName = state.projectName || 'Plan';
        syncUIFromState();
        resetView();
        fitToContent();
        refreshAll();
        setHint('Hover or tap a wall, door, window or ruler to measure it. Drag to pan, scroll to zoom.');
      } catch (err) {
        console.error(err);
        setHint(`Could not load ${file}`);
      }
      return;
    }

    const restored = await restoreTabs();
    if (!restored) {
      const t = makeTab();
      tabs.push(t);
      activeTabId = t.id;
      hydrateTab(t);
    }
    syncUIFromState();
    refreshAll();
    lastSavedSnapshot = serialize();
    updateFileMeta();
    updateSaveButton();
    renderTabStrip();
    persistTabs();
  })();

  // Polished default plot \u2014 a small 2-bedroom apartment using only the
  // palette colors. Demonstrates rooms, walls, doors, windows, text and a
  // measurement so the canvas isn't empty on first run.
  function seedSampleLayout() {
    state.projectName = 'Sample Apartment';
    const pn = document.getElementById('project-name');
    if (pn) pn.value = state.projectName;

    // All measurements in meters (~33ft x 23ft plot)
    const T = 0.15;            // wall thickness
    const W = 10, H = 7;       // plot interior

    const roomFill = {
      living:  '#e8f0ff', // sky tint
      kitchen: '#e7f7ec', // mint
      dining:  '#f3e9d2', // sand
      bed1:    '#fde9ef', // blush
      bed2:    '#efe8ff', // lilac
      bath:    '#e0f2fe', // pale sky
    };
    const stroke = '#94a3b8';
    const wallStroke = '#4a2e1c';

    state.objects = [
      // —— Parking (outside, to the right) ——
      makeObject('room', {
        x: W + 0.4, y: 0, w: 4, h: H,
        label: 'Parking',
        fill: '#f5efe6',
        stroke: '#94a3b8',
        strokeWidth: 2,
      }),
      // Parking perimeter walls (open on the side facing the house)
      makeObject('wall', { x1: W + 0.4, y1: 0,    x2: W + 4.4, y2: 0,    thickness: T, stroke: wallStroke }), // top
      makeObject('wall', { x1: W + 4.4, y1: 0,    x2: W + 4.4, y2: H,    thickness: T, stroke: wallStroke }), // right
      makeObject('wall', { x1: W + 4.4, y1: H,    x2: W + 0.4, y2: H,    thickness: T, stroke: wallStroke }), // bottom

      // —— Floor / zones ——
      makeObject('room', { x: 0,    y: 0,    w: 5.5, h: 4.2, label: 'Living Room', fill: roomFill.living,  stroke, strokeWidth: 2 }),
      makeObject('room', { x: 5.5,  y: 0,    w: 4.5, h: 2.5, label: 'Kitchen',     fill: roomFill.kitchen, stroke, strokeWidth: 2 }),
      makeObject('room', { x: 5.5,  y: 2.5,  w: 4.5, h: 1.7, label: 'Dining',      fill: roomFill.dining,  stroke, strokeWidth: 2 }),
      makeObject('room', { x: 0,    y: 4.2,  w: 4,   h: 2.8, label: 'Bedroom 1',   fill: roomFill.bed1,    stroke, strokeWidth: 2 }),
      makeObject('room', { x: 4,    y: 4.2,  w: 3.5, h: 2.8, label: 'Bedroom 2',   fill: roomFill.bed2,    stroke, strokeWidth: 2 }),
      makeObject('room', { x: 7.5,  y: 4.2,  w: 2.5, h: 2.8, label: 'Bathroom',    fill: roomFill.bath,    stroke, strokeWidth: 2 }),

      // \u2014\u2014 Outer walls (form the building shell) \u2014\u2014
      makeObject('wall', { x1: 0, y1: 0, x2: W, y2: 0, thickness: T, stroke: wallStroke }), // top
      makeObject('wall', { x1: W, y1: 0, x2: W, y2: H, thickness: T, stroke: wallStroke }), // right
      makeObject('wall', { x1: W, y1: H, x2: 0, y2: H, thickness: T, stroke: wallStroke }), // bottom
      makeObject('wall', { x1: 0, y1: H, x2: 0, y2: 0, thickness: T, stroke: wallStroke }), // left

      // \u2014\u2014 Interior walls \u2014\u2014
      makeObject('wall', { x1: 5.5, y1: 0,   x2: 5.5, y2: 4.2, thickness: T, stroke: wallStroke }), // living | kitchen/dining
      makeObject('wall', { x1: 5.5, y1: 2.5, x2: W,   y2: 2.5, thickness: T, stroke: wallStroke }), // kitchen | dining
      makeObject('wall', { x1: 0,   y1: 4.2, x2: W,   y2: 4.2, thickness: T, stroke: wallStroke }), // common | bedrooms
      makeObject('wall', { x1: 4,   y1: 4.2, x2: 4,   y2: H,   thickness: T, stroke: wallStroke }), // bed1 | bed2
      makeObject('wall', { x1: 7.5, y1: 4.2, x2: 7.5, y2: H,   thickness: T, stroke: wallStroke }), // bed2 | bath

      // \u2014\u2014 Doors (rot in degrees, w in metres) \u2014\u2014
      makeObject('door', { x: 1.4, y: 4.2, w: 0.9, rot: 0   }), // bedroom 1 entry
      makeObject('door', { x: 5.0, y: 4.2, w: 0.9, rot: 0   }), // bedroom 2 entry
      makeObject('door', { x: 8.4, y: 4.2, w: 0.8, rot: 0   }), // bathroom entry
      makeObject('door', { x: 5.5, y: 1.0, w: 0.9, rot: 90  }), // living -> kitchen
      makeObject('door', { x: 3.0, y: 0,   w: 1.0, rot: 0   }), // front entrance

      // \u2014\u2014 Windows \u2014\u2014
      makeObject('window', { x: 0.8, y: 0,   w: 1.6, rot: 0  }), // living window (front)
      makeObject('window', { x: 7.0, y: 0,   w: 1.4, rot: 0  }), // kitchen window
      makeObject('window', { x: 0,   y: 5.4, w: 1.4, rot: 90 }), // bedroom 1 (left wall)
      makeObject('window', { x: W,   y: 5.4, w: 1.4, rot: 90 }), // bathroom (right wall)

      // \u2014\u2014 Text labels \u2014\u2014
      makeObject('text', { x: 3.05, y: 0.45, text: 'Front Entrance', size: 12, fill: '#475569' }),

      // \u2014\u2014 Measurement (overall width) \u2014\u2014
      makeObject('measure', { x1: 0, y1: -0.55, x2: W, y2: -0.55 }),
    ];
  }
})();
