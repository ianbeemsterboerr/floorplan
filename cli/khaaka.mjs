#!/usr/bin/env node
/* Khaaka CLI — build and inspect Khaaka layout files from the terminal.
 *
 * Layout files are exactly the JSON the app exports and opens (File → Open),
 * so anything built here can be finished by hand in the browser and vice
 * versa. All geometry is stored in meters, matching the app.
 *
 * Zero dependencies, no build step — same rules as the app itself.
 */

import fs from 'node:fs';
import path from 'node:path';

const M_PER_FT = 0.3048;
const UNITS = ['ft', 'm', 'mm'];
const WALL_STROKE = '#4a2e1c';

// Services. One object type, `kind` picks the symbol — same as the editor.
const FIXTURES = {
  socket: { label: 'Socket',       color: '#b45309' },
  switch: { label: 'Switch',       color: '#b45309' },
  light:  { label: 'Light point',  color: '#b45309' },
  gas:    { label: 'Gas point',    color: '#a16207' },
  water:  { label: 'Water supply', color: '#0369a1' },
  drain:  { label: 'Drain',        color: '#475569' },
};
const FIXTURE_R = 9;       // symbol radius in output pixels
const NOTE_COLOR = '#7c3aed';
const NOTE_R = 10;
const FIXTURE_WORLD = 0.1; // nominal footprint in metres, for bounds only

// ---------- Units ----------

const mToFt = (m) => m / M_PER_FT;
const ftToM = (f) => f * M_PER_FT;

// Parse a length into meters. Accepts an explicit unit (`3200mm`, `1.5m`,
// `250cm`, `12ft`, `12'6"`, `12' 6in`) or a bare number, which is read in the
// layout's own display unit — the same rule the app's input fields use.
function parseLen(str, units) {
  if (str == null) return null;
  const s = String(str).trim().toLowerCase();
  if (s === '') return null;

  const metric = s.match(/^(-?\d*\.?\d+)\s*(mm|cm|m)$/);
  if (metric) {
    const v = parseFloat(metric[1]);
    if (metric[2] === 'mm') return v / 1000;
    if (metric[2] === 'cm') return v / 100;
    return v;
  }

  const ftIn = s.match(
    /^(?:(-?\d*\.?\d+)\s*(?:'|ft|feet|foot))?\s*[-\s]?\s*(?:(-?\d*\.?\d+)\s*(?:"|in|inch|inches))?$/
  );
  if (ftIn && (ftIn[1] || ftIn[2])) {
    return ftToM((parseFloat(ftIn[1] || '0') || 0) + (parseFloat(ftIn[2] || '0') || 0) / 12);
  }

  const bare = Number(s);
  if (!Number.isNaN(bare)) {
    if (units === 'ft') return ftToM(bare);
    if (units === 'mm') return bare / 1000;
    return bare;
  }
  return null;
}

// Same rounding the app uses when it draws a dimension.
function fmtLen(m, units) {
  if (units === 'ft') {
    const totalIn = mToFt(m) * 12;
    let ft = Math.trunc(totalIn / 12);
    let inches = Math.round((totalIn - ft * 12) * 100) / 100;
    if (inches >= 12) { ft += 1; inches -= 12; }
    return `${ft}'-${inches}"`;
  }
  if (units === 'mm') return `${Math.round(m * 1000)} mm`;
  return `${Math.round(m * 1000) / 1000} m`;
}

function fmtArea(m2, units) {
  if (units === 'ft') {
    const sqft = m2 / (M_PER_FT * M_PER_FT);
    return `${(sqft >= 1 ? Math.round(sqft) : Math.round(sqft * 10) / 10).toLocaleString('en-US')} sq ft`;
  }
  // Millimeter mode reports areas in m² too — mm² figures are unreadable.
  return `${m2 < 100 ? Math.round(m2 * 100) / 100 : Math.round(m2 * 10) / 10} m²`;
}

// `--at 1200,800` / `--from 0,0`. Each component takes its own unit.
function parsePoint(str, units, flag) {
  const parts = String(str ?? '').split(',');
  if (parts.length !== 2) throw new UserError(`${flag} expects "x,y" (got "${str}")`);
  const x = parseLen(parts[0], units), y = parseLen(parts[1], units);
  if (x == null || y == null) throw new UserError(`${flag}: could not read "${str}" as a coordinate`);
  return { x, y };
}

// `--size 4200x3600` or `--size "12'6\" x 10'"`.
function parseSize(str, units, flag) {
  const parts = String(str ?? '').split(/\s*x\s*/i);
  if (parts.length !== 2) throw new UserError(`${flag} expects "WxH" (got "${str}")`);
  const w = parseLen(parts[0], units), h = parseLen(parts[1], units);
  if (w == null || h == null) throw new UserError(`${flag}: could not read "${str}" as a size`);
  if (w <= 0 || h <= 0) throw new UserError(`${flag}: width and height must be positive`);
  return { w, h };
}

// ---------- Errors ----------

class UserError extends Error {}

// ---------- Layout file ----------

function blankLayout({ name = 'Untitled Layout', units = 'm', gridSize = null, boxPx = 25 } = {}) {
  const size = gridSize ?? (units === 'ft' ? ftToM(1) : units === 'mm' ? 0.25 : 0.25);
  return {
    version: 1,
    projectName: name,
    units,
    pxPerBox: boxPx,
    pxPerMeter: boxPx / size,
    grid: { show: true, snap: true, size },
    showDims: true,
    defaultWallThickness: 0.1524,
    view: { x: 60, y: 60, zoom: 1 },
    objects: [],
    nextId: 1,
  };
}

function load(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new UserError(`Cannot read ${file}. Create it first: khaaka new ${file}`);
  }
  let d;
  try {
    d = JSON.parse(raw);
  } catch (err) {
    throw new UserError(`${file} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(d.objects)) throw new UserError(`${file} has no "objects" array — is it a Khaaka layout?`);
  if (!UNITS.includes(d.units)) d.units = 'm';
  d.grid = d.grid || { show: true, snap: true, size: 0.25 };
  d.pxPerBox = d.pxPerBox || 25;
  d.nextId = d.nextId || Math.max(0, ...d.objects.map((o) => o.id || 0)) + 1;
  syncRulers(d);
  return d;
}

function save(file, d) {
  syncRulers(d);
  // Keep the derived fields consistent with the app's own invariants.
  if (d.grid.size > 0) d.pxPerMeter = d.pxPerBox / d.grid.size;
  d.nextId = Math.max(d.nextId || 1, ...d.objects.map((o) => (o.id || 0) + 1));
  d.view = frameView(d);
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
}

// Pan/zoom so the whole layout is on screen when the file is opened.
// Sized for a typical window; the user can still hit 0 to reset.
function frameView(d) {
  const box = layoutBounds(d);
  if (!box) return { x: 60, y: 60, zoom: 1 };
  const CANVAS_W = 1180, CANVAS_H = 560, PAD = 40;
  const fit = Math.min(
    (CANVAS_W - PAD * 2) / Math.max(0.01, box.w * d.pxPerMeter),
    (CANVAS_H - PAD * 2) / Math.max(0.01, box.h * d.pxPerMeter)
  );
  const zoom = Math.max(0.1, Math.min(8, Math.round(fit * 100) / 100));
  return {
    x: Math.round(PAD - box.x * d.pxPerMeter * zoom),
    y: Math.round(PAD - box.y * d.pxPerMeter * zoom),
    zoom,
  };
}

// ---------- Geometry ----------

// A ruler stores the wall id it annotates, a signed perpendicular offset,
// and a cached copy of the wall's span. Refresh the cache whenever the file
// is read or written; a ruler whose wall is gone keeps its last geometry.
function syncRulers(d) {
  for (const o of d.objects) {
    if (o.type !== 'ruler' || o.wallId == null) continue;
    const wall = d.objects.find((x) => x.id === o.wallId && x.type === 'wall');
    if (!wall) continue;
    o.x1 = wall.x1; o.y1 = wall.y1; o.x2 = wall.x2; o.y2 = wall.y2;
  }
}

// The offset line a ruler is actually drawn on.
function rulerLine(o) {
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const nx = -dy / len, ny = dx / len;
  const off = o.offset || 0;
  return { len, nx, ny, ax: o.x1 + nx * off, ay: o.y1 + ny * off, bx: o.x2 + nx * off, by: o.y2 + ny * off };
}

function bounds(o) {
  switch (o.type) {
    case 'room':
      return { x: o.x, y: o.y, w: o.w, h: o.h };
    case 'polygon': {
      const pts = o.points || [];
      if (!pts.length) return null;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    case 'wall':
    case 'measure':
      return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
    case 'ruler': {
      const L = rulerLine(o);
      if (!L) return null;
      return { x: Math.min(L.ax, L.bx), y: Math.min(L.ay, L.by), w: Math.abs(L.bx - L.ax), h: Math.abs(L.by - L.ay) };
    }
    case 'door':
    case 'window': {
      const rad = ((o.rot || 0) * Math.PI) / 180;
      const ex = o.x + Math.cos(rad) * o.w, ey = o.y + Math.sin(rad) * o.w;
      return { x: Math.min(o.x, ex), y: Math.min(o.y, ey), w: Math.abs(ex - o.x), h: Math.abs(ey - o.y) };
    }
    case 'fixture':
    case 'note':
      return { x: o.x - FIXTURE_WORLD, y: o.y - FIXTURE_WORLD,
               w: FIXTURE_WORLD * 2, h: FIXTURE_WORLD * 2 };
    case 'text':
      return { x: o.x, y: o.y - 0.3, w: 0.2 * (o.text || '').length, h: 0.4 };
    default:
      return null;
  }
}

function layoutBounds(d) {
  const boxes = d.objects.map(bounds).filter(Boolean);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

const rectOverlap = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

// Shoelace area of a polygon.
const polygonArea = (pts) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return Math.abs(a / 2);
};

// A room's own area minus whatever later rooms cover, matching the app's
// layer model so the sum over all rooms is the true floor area.
function netArea(d, o) {
  if (o.type === 'polygon') return polygonArea(o.points || []);
  if (o.type !== 'room') return 0;
  let area = o.w * o.h;
  const idx = d.objects.indexOf(o);
  for (let i = idx + 1; i < d.objects.length; i++) {
    const other = d.objects[i];
    if (other.type === 'room') area -= rectOverlap(o, other);
  }
  return Math.max(0, area);
}

// ---------- Object creation ----------

function makeObject(d, type, props) {
  return Object.assign(
    { id: d.nextId++, type, label: '', fill: '#e8f0ff', stroke: '#1f3a8a', strokeWidth: 2 },
    props
  );
}

function addWallsForRoom(d, room, thickness) {
  const t = thickness ?? d.defaultWallThickness;
  const { x, y, w, h } = room;
  const sides = [
    { x1: x, y1: y, x2: x + w, y2: y },
    { x1: x + w, y1: y, x2: x + w, y2: y + h },
    { x1: x, y1: y + h, x2: x + w, y2: y + h },
    { x1: x, y1: y, x2: x, y2: y + h },
  ];
  return sides.map((s) => {
    const wall = makeObject(d, 'wall', { ...s, thickness: t, stroke: WALL_STROKE });
    d.objects.push(wall);
    return wall;
  });
}

// ---------- Argument parsing ----------

// Splits a command line into tokens, honouring single and double quotes so
// labels like --label "Living room" and sizes like "12'6\" x 10'" survive.
function tokenize(line) {
  const out = [];
  let cur = '', quote = null, has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && line[i + 1] === quote) { cur += line[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c; has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += c;
    }
  }
  if (quote) throw new UserError(`unbalanced ${quote} quote`);
  if (cur || has) out.push(cur);
  return out;
}

// `--flag value` / `--flag=value` / `--bool`. Bare words become positionals.
function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else if (a === '-o') {
      flags.out = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function need(flags, name, cmd) {
  const v = flags[name];
  if (v === undefined || v === true) throw new UserError(`${cmd}: --${name} is required`);
  return v;
}

const known = (flags, allowed, cmd) => {
  for (const k of Object.keys(flags)) {
    if (!allowed.includes(k)) throw new UserError(`${cmd}: unknown option --${k}`);
  }
};

function applyCommon(o, flags) {
  if (flags.label !== undefined && flags.label !== true) o.label = String(flags.label);
  if (flags.fill !== undefined && flags.fill !== true) o.fill = String(flags.fill);
  if (flags.stroke !== undefined && flags.stroke !== true) o.stroke = String(flags.stroke);
  if (flags.locked === true || flags.locked === 'true') o.locked = true;
  if (flags.hidden === true || flags.hidden === 'true') o.hidden = true;
  return o;
}

// ---------- Commands that mutate a layout ----------
// Each returns a one-line description of what it did.

const MUTATORS = {
  'add-room'(d, flags) {
    known(flags, ['at', 'size', 'label', 'fill', 'stroke', 'walls', 'thickness', 'area', 'locked', 'hidden'], 'add-room');
    const at = parsePoint(need(flags, 'at', 'add-room'), d.units, '--at');
    const size = parseSize(need(flags, 'size', 'add-room'), d.units, '--size');
    const room = applyCommon(makeObject(d, 'room', { x: at.x, y: at.y, w: size.w, h: size.h }), flags);
    if (flags.area === true || flags.area === 'true') {
      // Below centre, so the area caption clears the room name.
      room.showArea = true;
      room.areaPos = { fx: 0.5, fy: 0.62 };
    }
    d.objects.push(room);
    let msg = `room #${room.id}${room.label ? ` "${room.label}"` : ''} ${fmtLen(size.w, d.units)} × ${fmtLen(size.h, d.units)} (${fmtArea(size.w * size.h, d.units)})`;
    if (flags.walls === true || flags.walls === 'true') {
      const t = flags.thickness !== undefined && flags.thickness !== true
        ? parseLen(flags.thickness, d.units) : undefined;
      const walls = addWallsForRoom(d, room, t);
      msg += ` + ${walls.length} walls (#${walls[0].id}–#${walls[walls.length - 1].id})`;
    }
    return msg;
  },

  'add-wall'(d, flags) {
    known(flags, ['from', 'to', 'thickness', 'label', 'fill', 'stroke', 'locked', 'hidden'], 'add-wall');
    const a = parsePoint(need(flags, 'from', 'add-wall'), d.units, '--from');
    const b = parsePoint(need(flags, 'to', 'add-wall'), d.units, '--to');
    const t = flags.thickness !== undefined && flags.thickness !== true
      ? parseLen(flags.thickness, d.units) : d.defaultWallThickness;
    if (!t || t <= 0) throw new UserError('add-wall: --thickness must be positive');
    const wall = applyCommon(
      makeObject(d, 'wall', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, thickness: t, stroke: WALL_STROKE }),
      flags
    );
    d.objects.push(wall);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len <= 0) throw new UserError('add-wall: --from and --to are the same point');
    return `wall #${wall.id} ${fmtLen(len, d.units)} long, ${fmtLen(t, d.units)} thick`;
  },

  'add-door'(d, flags) { return opening(d, flags, 'door', 0.9); },
  'add-window'(d, flags) { return opening(d, flags, 'window', 1.2); },

  'add-text'(d, flags) {
    known(flags, ['at', 'above', 'gap', 'text', 'size', 'fill', 'label', 'locked', 'hidden'], 'add-text');
    // --above drops the note in clear space over the whole drawing, working
    // it out from everything already placed — rulers included — so it can't
    // land on top of anything.
    let at;
    if (flags.above === true || flags.above === 'true') {
      if (flags.at !== undefined) throw new UserError('add-text: give --at or --above, not both');
      const box = layoutBounds(d);
      const gap = flags.gap !== undefined && flags.gap !== true
        ? (parseLen(flags.gap, d.units) ?? 0.6) : 0.6;
      at = box ? { x: box.x, y: box.y - gap } : { x: 0, y: 0 };
    } else {
      at = parsePoint(need(flags, 'at', 'add-text'), d.units, '--at');
    }
    const text = String(need(flags, 'text', 'add-text'));
    const size = flags.size !== undefined && flags.size !== true ? Number(flags.size) : 14;
    if (!Number.isFinite(size) || size <= 0) throw new UserError('add-text: --size must be a positive number of screen pixels');
    const o = applyCommon(makeObject(d, 'text', { x: at.x, y: at.y, text, size, fill: '#111827' }), flags);
    d.objects.push(o);
    return `text #${o.id} "${text}"`;
  },

  'add-measure'(d, flags) {
    known(flags, ['from', 'to', 'label', 'stroke', 'locked', 'hidden'], 'add-measure');
    const a = parsePoint(need(flags, 'from', 'add-measure'), d.units, '--from');
    const b = parsePoint(need(flags, 'to', 'add-measure'), d.units, '--to');
    const o = applyCommon(makeObject(d, 'measure', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }), flags);
    d.objects.push(o);
    return `measure #${o.id} ${fmtLen(Math.hypot(b.x - a.x, b.y - a.y), d.units)}`;
  },

  'add-polygon'(d, flags) {
    known(flags, ['points', 'label', 'fill', 'stroke', 'area', 'locked', 'hidden'], 'add-polygon');
    const raw = String(need(flags, 'points', 'add-polygon')).trim();
    const pts = raw.split(/\s+/).map((p, i) => parsePoint(p, d.units, `--points[${i}]`));
    if (pts.length < 3) throw new UserError('add-polygon: --points needs at least 3 "x,y" pairs');
    const o = applyCommon(makeObject(d, 'polygon', { points: pts, closed: true }), flags);
    if (flags.area === true || flags.area === 'true') {
      o.showArea = true;
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      o.areaPos = { x: cx, y: cy };
    }
    d.objects.push(o);
    return `polygon #${o.id} ${pts.length} vertices (${fmtArea(polygonArea(pts), d.units)})`;
  },

  'add-note'(d, flags) {
    known(flags, ['at', 'text', 'label', 'locked', 'hidden'], 'add-note');
    const at = parsePoint(need(flags, 'at', 'add-note'), d.units, '--at');
    const text = String(need(flags, 'text', 'add-note'));
    const o = applyCommon(makeObject(d, 'note', { x: at.x, y: at.y, text, stroke: NOTE_COLOR }), flags);
    d.objects.push(o);
    const n = d.objects.filter((x) => x.type === 'note').length;
    return `note ${n} (#${o.id}) at ${fmtLen(at.x, d.units)}, ${fmtLen(at.y, d.units)}`;
  },

  'add-fixture'(d, flags) {
    known(flags, ['kind', 'at', 'rot', 'label', 'stroke', 'locked', 'hidden'], 'add-fixture');
    const kind = String(need(flags, 'kind', 'add-fixture'));
    if (!FIXTURES[kind]) {
      throw new UserError(`add-fixture: --kind must be one of ${Object.keys(FIXTURES).join(', ')}`);
    }
    const at = parsePoint(need(flags, 'at', 'add-fixture'), d.units, '--at');
    const rot = flags.rot !== undefined && flags.rot !== true ? Number(flags.rot) : 0;
    if (!Number.isFinite(rot)) throw new UserError('add-fixture: --rot must be a number of degrees');
    const o = applyCommon(
      makeObject(d, 'fixture', { kind, x: at.x, y: at.y, rot, stroke: FIXTURES[kind].color }),
      flags
    );
    d.objects.push(o);
    return `${FIXTURES[kind].label.toLowerCase()} #${o.id} at ${fmtLen(at.x, d.units)}, ${fmtLen(at.y, d.units)}`;
  },

  'add-ruler'(d, flags) {
    known(flags, ['wall', 'offset', 'flip', 'label', 'stroke', 'locked', 'hidden'], 'add-ruler');
    const wallId = parseInt(String(need(flags, 'wall', 'add-ruler')), 10);
    const wall = d.objects.find((o) => o.id === wallId);
    if (!wall) throw new UserError(`add-ruler: no object with id ${wallId}`);
    if (wall.type !== 'wall') throw new UserError(`add-ruler: #${wallId} is a ${wall.type}, not a wall`);
    // --offset is the gap beyond the last room, not a raw distance: the
    // ruler always clears the plan. --flip picks the other side.
    const margin = flags.offset !== undefined && flags.offset !== true
      ? Math.abs(parseLen(flags.offset, d.units) ?? 0) : 0.4;
    if (!margin) throw new UserError('add-ruler: --offset must be a positive length');
    let off = outwardOffset(d, wall, margin);
    if (flags.flip === true || flags.flip === 'true') off = -off;
    const sign = off < 0 ? -1 : 1;
    const mag = Math.abs(off);
    const o = applyCommon(
      makeObject(d, 'ruler', {
        wallId, offset: sign * mag, x1: wall.x1, y1: wall.y1, x2: wall.x2, y2: wall.y2, stroke: '#8a93a6',
      }),
      flags
    );
    d.objects.push(o);
    const len = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    return `ruler #${o.id} on wall #${wallId} (${fmtLen(len, d.units)}), ${fmtLen(mag, d.units)} clear`;
  },

  remove(d, flags) {
    known(flags, ['id'], 'remove');
    const ids = String(need(flags, 'id', 'remove')).split(',').map((s) => parseInt(s.trim(), 10));
    const missing = ids.filter((id) => !d.objects.some((o) => o.id === id));
    if (missing.length) throw new UserError(`remove: no object with id ${missing.join(', ')}`);
    d.objects = d.objects.filter((o) => !ids.includes(o.id));
    return `removed #${ids.join(', #')}`;
  },

  move(d, flags) {
    known(flags, ['id', 'by', 'to'], 'move');
    const id = parseInt(String(need(flags, 'id', 'move')), 10);
    const o = d.objects.find((x) => x.id === id);
    if (!o) throw new UserError(`move: no object with id ${id}`);
    if ((flags.by === undefined) === (flags.to === undefined)) {
      throw new UserError('move: give exactly one of --by dx,dy or --to x,y');
    }
    let dx, dy;
    if (flags.by !== undefined) {
      ({ x: dx, y: dy } = parsePoint(flags.by, d.units, '--by'));
    } else {
      const target = parsePoint(flags.to, d.units, '--to');
      const b = bounds(o);
      if (!b) throw new UserError(`move: cannot place a ${o.type} by bounds`);
      dx = target.x - b.x;
      dy = target.y - b.y;
    }
    translate(o, dx, dy);
    return `moved #${id} by ${fmtLen(dx, d.units)}, ${fmtLen(dy, d.units)}`;
  },

  set(d, flags) {
    known(flags, ['name', 'units', 'grid', 'box-px', 'show-dims', 'snap', 'wall-thickness'], 'set');
    const done = [];
    if (flags.name !== undefined && flags.name !== true) { d.projectName = String(flags.name); done.push(`name "${d.projectName}"`); }
    if (flags.units !== undefined && flags.units !== true) {
      if (!UNITS.includes(flags.units)) throw new UserError(`set: --units must be one of ${UNITS.join(', ')}`);
      d.units = flags.units;
      done.push(`units ${d.units}`);
    }
    if (flags.grid !== undefined && flags.grid !== true) {
      const size = parseLen(flags.grid, d.units);
      if (!size || size <= 0) throw new UserError('set: --grid must be a positive length');
      d.grid.size = size;
      done.push(`grid ${fmtLen(size, d.units)}`);
    }
    if (flags['box-px'] !== undefined && flags['box-px'] !== true) {
      const px = Number(flags['box-px']);
      if (!Number.isFinite(px) || px <= 0) throw new UserError('set: --box-px must be a positive number');
      d.pxPerBox = px;
      done.push(`${px}px per grid box`);
    }
    if (flags['show-dims'] !== undefined) { d.showDims = flags['show-dims'] !== 'false'; done.push(`dimensions ${d.showDims ? 'on' : 'off'}`); }
    if (flags.snap !== undefined) { d.grid.snap = flags.snap !== 'false'; done.push(`snap ${d.grid.snap ? 'on' : 'off'}`); }
    if (flags['wall-thickness'] !== undefined && flags['wall-thickness'] !== true) {
      const t = parseLen(flags['wall-thickness'], d.units);
      if (!t || t <= 0) throw new UserError('set: --wall-thickness must be a positive length');
      d.defaultWallThickness = t;
      done.push(`default wall ${fmtLen(t, d.units)}`);
    }
    if (!done.length) throw new UserError('set: nothing to change');
    return done.join(', ');
  },
};

function opening(d, flags, type, defaultWidth) {
  known(flags, ['at', 'width', 'rot', 'label', 'fill', 'stroke', 'locked', 'hidden'], `add-${type}`);
  const at = parsePoint(need(flags, 'at', `add-${type}`), d.units, '--at');
  const w = flags.width !== undefined && flags.width !== true
    ? parseLen(flags.width, d.units) : defaultWidth;
  if (!w || w <= 0) throw new UserError(`add-${type}: --width must be a positive length`);
  const rot = flags.rot !== undefined && flags.rot !== true ? Number(flags.rot) : 0;
  if (!Number.isFinite(rot)) throw new UserError(`add-${type}: --rot must be a number of degrees`);
  const o = applyCommon(makeObject(d, type, { x: at.x, y: at.y, w, rot }), flags);
  d.objects.push(o);
  return `${type} #${o.id} ${fmtLen(w, d.units)} wide at ${rot}°`;
}

// Signed offset that puts a ruler clear of every room, on the side facing
// away from the plan — dimensions belong outside the drawing, not across it.
// Rulers already parked at that distance are stepped past. `margin` is the
// gap beyond the last room.
function outwardOffset(d, wall, margin) {
  const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return margin;
  const nx = -dy / len, ny = dx / len;
  const rooms = d.objects
    .filter((o) => o.type === 'room' || o.type === 'polygon')
    .map(bounds)
    .filter((b) => b && b.w > 0);
  if (!rooms.length) return -margin;

  const cx = rooms.reduce((s, b) => s + b.x + b.w / 2, 0) / rooms.length;
  const cy = rooms.reduce((s, b) => s + b.y + b.h / 2, 0) / rooms.length;
  const mx = (wall.x1 + wall.x2) / 2, my = (wall.y1 + wall.y2) / 2;
  const sign = (mx - cx) * nx + (my - cy) * ny >= 0 ? 1 : -1;

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
  for (const o of d.objects) {
    if (o.type !== 'ruler') continue;
    const ol = rulerLine(o);
    if (!ol || Math.abs(ol.nx * nx + ol.ny * ny) < 0.99) continue;
    parallel.push(ol.ax * nx + ol.ay * ny);
  }
  for (let guard = 0; guard < 40; guard++) {
    const proj = (mx + nx * sign * dist) * nx + (my + ny * sign * dist) * ny;
    if (!parallel.some((pp) => Math.abs(pp - proj) < margin * 0.9)) break;
    dist += margin;
  }
  return sign * dist;
}

function translate(o, dx, dy) {
  switch (o.type) {
    case 'wall':
    case 'measure':
      o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; break;
    case 'polygon':
      o.points = o.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      if (o.areaPos && o.areaPos.x !== undefined) { o.areaPos.x += dx; o.areaPos.y += dy; }
      break;
    default:
      o.x += dx; o.y += dy;
  }
}

// ---------- Read-only commands ----------

function describe(d, o) {
  const u = d.units;
  switch (o.type) {
    case 'room':
      return `at ${fmtLen(o.x, u)}, ${fmtLen(o.y, u)}  ${fmtLen(o.w, u)} × ${fmtLen(o.h, u)}  ${fmtArea(netArea(d, o), u)}`;
    case 'polygon':
      return `${(o.points || []).length} vertices  ${fmtArea(polygonArea(o.points || []), u)}`;
    case 'wall':
      return `${fmtLen(o.x1, u)}, ${fmtLen(o.y1, u)} → ${fmtLen(o.x2, u)}, ${fmtLen(o.y2, u)}  len ${fmtLen(Math.hypot(o.x2 - o.x1, o.y2 - o.y1), u)}  thick ${fmtLen(o.thickness || d.defaultWallThickness, u)}`;
    case 'measure':
      return `${fmtLen(o.x1, u)}, ${fmtLen(o.y1, u)} → ${fmtLen(o.x2, u)}, ${fmtLen(o.y2, u)}  len ${fmtLen(Math.hypot(o.x2 - o.x1, o.y2 - o.y1), u)}`;
    case 'door':
    case 'window':
      return `at ${fmtLen(o.x, u)}, ${fmtLen(o.y, u)}  width ${fmtLen(o.w, u)}  rot ${o.rot || 0}°`;
    case 'ruler': {
      const attached = o.wallId != null && d.objects.some((x) => x.id === o.wallId && x.type === 'wall');
      const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      return `${attached ? `wall #${o.wallId}` : 'detached'}  reads ${fmtLen(len, u)}  ${fmtLen(Math.abs(o.offset || 0), u)} clear`;
    }
    case 'fixture':
      return `${(FIXTURES[o.kind] || {}).label || o.kind}  at ${fmtLen(o.x, u)}, ${fmtLen(o.y, u)}${o.rot ? `  rot ${o.rot}°` : ''}`;
    case 'note':
      return `at ${fmtLen(o.x, u)}, ${fmtLen(o.y, u)}  "${o.text}"`;
    case 'text':
      return `at ${fmtLen(o.x, u)}, ${fmtLen(o.y, u)}  "${o.text}"  ${o.size || 14}px`;
    default:
      return '';
  }
}

function list(d, file) {
  const box = layoutBounds(d);
  const lines = [
    `${d.projectName}  (${file})`,
    `units ${d.units}   grid ${fmtLen(d.grid.size, d.units)}   default wall ${fmtLen(d.defaultWallThickness, d.units)}`,
    box
      ? `extent ${fmtLen(box.w, d.units)} × ${fmtLen(box.h, d.units)} from ${fmtLen(box.x, d.units)}, ${fmtLen(box.y, d.units)}`
      : 'empty layout',
    '',
  ];
  if (d.objects.length) {
    const w = Math.max(...d.objects.map((o) => (o.label || `${o.type} #${o.id}`).length));
    for (const o of d.objects) {
      const name = (o.label || `${o.type} #${o.id}`).padEnd(w);
      const tags = [o.locked && 'locked', o.hidden && 'hidden'].filter(Boolean).join(' ');
      lines.push(`  #${String(o.id).padStart(3)}  ${o.type.padEnd(8)} ${name}  ${describe(d, o)}${tags ? `  [${tags}]` : ''}`);
    }
    const floor = d.objects.reduce((sum, o) => sum + netArea(d, o), 0);
    const counts = {};
    for (const o of d.objects) counts[o.type] = (counts[o.type] || 0) + 1;
    lines.push('');
    lines.push(`  ${d.objects.length} objects (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})`);
    if (floor > 0) lines.push(`  floor area ${fmtArea(floor, d.units)}  (rooms and polygons, overlaps counted once)`);
  }
  return lines.join('\n');
}

// ---------- SVG preview ----------

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function toSvg(d, { width = 1200 } = {}) {
  const box = layoutBounds(d) || { x: 0, y: 0, w: 1, h: 1 };
  const PAD = 0.5; // meters of margin around the content
  const wm = box.w + PAD * 2, hm = box.h + PAD * 2;
  const s = width / wm;                       // px per meter
  const height = Math.round(hm * s);
  const X = (x) => ((x - box.x + PAD) * s).toFixed(2);
  const Y = (y) => ((y - box.y + PAD) * s).toFixed(2);
  const out = [];

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">`);
  out.push(`<rect width="${width}" height="${height}" fill="#f7f8fb"/>`);

  // Grid, matching the layout's own box size.
  const g = d.grid.size;
  if (g > 0 && wm / g < 400) {
    const parts = [];
    for (let x = Math.ceil((box.x - PAD) / g) * g; x <= box.x + box.w + PAD; x += g) parts.push(`M${X(x)} 0V${height}`);
    for (let y = Math.ceil((box.y - PAD) / g) * g; y <= box.y + box.h + PAD; y += g) parts.push(`M0 ${Y(y)}H${width}`);
    out.push(`<path d="${parts.join('')}" stroke="#dfe4ee" stroke-width="1" fill="none"/>`);
  }

  // Rulers are emitted last, whatever their z-order, so their labels are
  // never buried by a wall or room added after them.
  const ordered = [
    ...d.objects.filter((o) => o.type !== 'ruler'),
    ...d.objects.filter((o) => o.type === 'ruler'),
  ];
  for (const o of ordered) {
    if (o.hidden) continue;
    switch (o.type) {
      case 'room': {
        out.push(`<rect x="${X(o.x)}" y="${Y(o.y)}" width="${(o.w * s).toFixed(2)}" height="${(o.h * s).toFixed(2)}" fill="${esc(o.fill || '#e8f0ff')}" stroke="${esc(o.stroke || '#1f3a8a')}" stroke-width="${o.strokeWidth || 2}"/>`);
        const cx = X(o.x + o.w / 2), cy = Y(o.y + o.h / 2);
        if (o.label) out.push(`<text x="${cx}" y="${cy}" text-anchor="middle" font-size="14" fill="#1c2433">${esc(o.label)}</text>`);
        // Only when the room asks for it, matching the app.
        if (o.showArea) {
          out.push(`<text x="${cx}" y="${(+cy + (o.label ? 18 : 5)).toFixed(2)}" text-anchor="middle" font-size="11" fill="#5b6577">${esc(fmtArea(netArea(d, o), d.units))}</text>`);
        }
        // Edge dimensions, so a mistyped number is obvious at a glance.
        out.push(`<text x="${cx}" y="${(+Y(o.y) - 5).toFixed(2)}" text-anchor="middle" font-size="11" fill="#5b6577">${esc(fmtLen(o.w, d.units))}</text>`);
        out.push(`<text x="${(+X(o.x) - 6).toFixed(2)}" y="${cy}" text-anchor="middle" font-size="11" fill="#5b6577" transform="rotate(-90 ${(+X(o.x) - 6).toFixed(2)} ${cy})">${esc(fmtLen(o.h, d.units))}</text>`);
        break;
      }
      case 'polygon': {
        const pts = (o.points || []).map((p) => `${X(p.x)},${Y(p.y)}`).join(' ');
        out.push(`<polygon points="${pts}" fill="${esc(o.fill || '#e8f0ff')}" stroke="${esc(o.stroke || '#1f3a8a')}" stroke-width="${o.strokeWidth || 2}"/>`);
        if (o.label) {
          const cx = (o.points.reduce((a, p) => a + p.x, 0) / o.points.length);
          const cy = (o.points.reduce((a, p) => a + p.y, 0) / o.points.length);
          out.push(`<text x="${X(cx)}" y="${Y(cy)}" text-anchor="middle" font-size="14" fill="#1c2433">${esc(o.label)}</text>`);
        }
        break;
      }
      case 'wall': {
        const t = Math.max(1, (o.thickness || d.defaultWallThickness) * s);
        out.push(`<line x1="${X(o.x1)}" y1="${Y(o.y1)}" x2="${X(o.x2)}" y2="${Y(o.y2)}" stroke="${esc(o.stroke || WALL_STROKE)}" stroke-width="${t.toFixed(2)}" stroke-linecap="butt"/>`);
        break;
      }
      case 'door':
      case 'window': {
        const rad = ((o.rot || 0) * Math.PI) / 180;
        const ex = o.x + Math.cos(rad) * o.w, ey = o.y + Math.sin(rad) * o.w;
        const color = o.type === 'door' ? '#b45309' : '#0369a1';
        out.push(`<line x1="${X(o.x)}" y1="${Y(o.y)}" x2="${X(ex)}" y2="${Y(ey)}" stroke="${color}" stroke-width="4"/>`);
        if (o.type === 'door') {
          const sx = o.x + Math.cos(rad + Math.PI / 2) * o.w, sy = o.y + Math.sin(rad + Math.PI / 2) * o.w;
          out.push(`<path d="M${X(ex)} ${Y(ey)} A ${(o.w * s).toFixed(2)} ${(o.w * s).toFixed(2)} 0 0 1 ${X(sx)} ${Y(sy)}" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="4 3"/>`);
        }
        break;
      }
      case 'measure': {
        out.push(`<line x1="${X(o.x1)}" y1="${Y(o.y1)}" x2="${X(o.x2)}" y2="${Y(o.y2)}" stroke="#64748b" stroke-width="1.5" stroke-dasharray="6 4"/>`);
        out.push(`<text x="${X((o.x1 + o.x2) / 2)}" y="${(+Y((o.y1 + o.y2) / 2) - 6).toFixed(2)}" text-anchor="middle" font-size="11" fill="#475569">${esc(fmtLen(Math.hypot(o.x2 - o.x1, o.y2 - o.y1), d.units))}</text>`);
        break;
      }
      case 'ruler': {
        const L = rulerLine(o);
        if (!L) break;
        const grey = '#5b6478';
        // Witness lines from the wall out past the dimension line.
        for (const [p0, p1] of [[[o.x1, o.y1], [L.ax, L.ay]], [[o.x2, o.y2], [L.bx, L.by]]]) {
          out.push(`<line x1="${X(p0[0])}" y1="${Y(p0[1])}" x2="${X(p1[0] + L.nx * 0.06)}" y2="${Y(p1[1] + L.ny * 0.06)}" stroke="#8a93a6" stroke-width="1" stroke-dasharray="3 3"/>`);
        }
        out.push(`<line x1="${X(L.ax)}" y1="${Y(L.ay)}" x2="${X(L.bx)}" y2="${Y(L.by)}" stroke="${grey}" stroke-width="1"/>`);
        for (const [px, py] of [[L.ax, L.ay], [L.bx, L.by]]) {
          out.push(`<line x1="${X(px - L.nx * 0.06)}" y1="${Y(py - L.ny * 0.06)}" x2="${X(px + L.nx * 0.06)}" y2="${Y(py + L.ny * 0.06)}" stroke="${grey}" stroke-width="1"/>`);
        }
        const mx = (L.ax + L.bx) / 2, my = (L.ay + L.by) / 2;
        const label = o.label ? `${o.label}  ${fmtLen(L.len, d.units)}` : fmtLen(L.len, d.units);
        out.push(`<text x="${X(mx)}" y="${(+Y(my) - 4).toFixed(2)}" text-anchor="middle" font-size="12" font-weight="600" fill="#1c2433">${esc(label)}</text>`);
        break;
      }
      case 'note': {
        const n = d.objects.filter((x) => x.type === 'note').indexOf(o) + 1;
        out.push(`<circle cx="${X(o.x)}" cy="${Y(o.y)}" r="${NOTE_R}" fill="${NOTE_COLOR}" stroke="#fff" stroke-width="1.5"/>`);
        out.push(`<text x="${X(o.x)}" y="${Y(o.y)}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="#fff">${n}</text>`);
        break;
      }
      case 'fixture': {
        const meta = FIXTURES[o.kind] || FIXTURES.socket;
        const c = o.stroke || meta.color;
        const R = FIXTURE_R;
        const g = [];
        if (o.kind === 'socket') {
          g.push(`<path d="M${-R} 0a${R} ${R} 0 0 1 ${R * 2} 0z" fill="${c}" fill-opacity="0.18" stroke="${c}" stroke-width="1.6"/>`);
          g.push(`<path d="M${-R} 0H${R}M0 0v${R + 4}" stroke="${c}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`);
        } else if (o.kind === 'switch') {
          g.push(`<circle cx="0" cy="${R * 0.6}" r="2.8" fill="${c}"/>`);
          g.push(`<path d="M0 ${R * 0.6}L${R * 0.95} ${-R * 0.75}M${R * 0.35} ${-R * 0.95}L${R * 1.05} ${-R * 0.55}" stroke="${c}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`);
        } else if (o.kind === 'light') {
          const dd = (R * 0.707).toFixed(2);
          g.push(`<circle cx="0" cy="0" r="${R}" fill="none" stroke="${c}" stroke-width="1.6"/>`);
          g.push(`<path d="M${-dd} ${-dd}L${dd} ${dd}M${dd} ${-dd}L${-dd} ${dd}" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`);
        } else if (o.kind === 'gas') {
          const pts = [];
          for (let i = 0; i < 6; i++) {
            const a = Math.PI / 6 + i * Math.PI / 3;
            pts.push(`${(Math.cos(a) * R).toFixed(2)},${(Math.sin(a) * R).toFixed(2)}`);
          }
          g.push(`<polygon points="${pts.join(' ')}" fill="none" stroke="${c}" stroke-width="1.6"/>`);
          g.push(`<text x="0" y="0.5" text-anchor="middle" dominant-baseline="middle" font-size="10" font-weight="700" fill="${c}">G</text>`);
        } else if (o.kind === 'water') {
          g.push(`<path d="M0 ${-R}C${R * 1.05} ${-R * 0.1} ${R * 0.8} ${R} 0 ${R}C${-R * 0.8} ${R} ${-R * 1.05} ${-R * 0.1} 0 ${-R}z" fill="${c}" fill-opacity="0.18" stroke="${c}" stroke-width="1.6"/>`);
        } else if (o.kind === 'drain') {
          g.push(`<circle cx="0" cy="0" r="${R}" fill="none" stroke="${c}" stroke-width="1.6"/>`);
          g.push(`<path d="M0 ${-R * 0.6}V${R * 0.45}M${-R * 0.45} ${-R * 0.05}L0 ${R * 0.5}L${R * 0.45} ${-R * 0.05}" stroke="${c}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
        }
        out.push(`<g transform="translate(${X(o.x)} ${Y(o.y)}) rotate(${o.rot || 0})">${g.join('')}</g>`);
        if (o.label) {
          out.push(`<text x="${X(o.x)}" y="${(+Y(o.y) + R + 12).toFixed(2)}" text-anchor="middle" font-size="10" fill="#475569">${esc(o.label)}</text>`);
        }
        break;
      }
      case 'text':
        out.push(`<text x="${X(o.x)}" y="${Y(o.y)}" font-size="${o.size || 14}" fill="${esc(o.fill || '#111827')}">${esc(o.text)}</text>`);
        break;
    }
  }
  out.push('</svg>');
  return out.join('\n');
}

// ---------- Script runner ----------

// Runs a .khk script: one command per line, no leading `khaaka`, no file
// argument. Nothing is written unless every line succeeds, so a typo in
// line 30 can't leave a half-built layout on disk.
function runScript(d, text, source) {
  const messages = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    let tokens;
    try {
      tokens = tokenize(line);
    } catch (err) {
      throw new UserError(`${source}:${i + 1}: ${err.message}`);
    }
    const cmd = tokens[0];
    const fn = MUTATORS[cmd];
    if (!fn) throw new UserError(`${source}:${i + 1}: unknown command "${cmd}"`);
    const { flags } = parseArgs(tokens.slice(1));
    try {
      messages.push(`  ${String(i + 1).padStart(3)}  ${fn(d, flags)}`);
    } catch (err) {
      if (err instanceof UserError) throw new UserError(`${source}:${i + 1}: ${err.message}`);
      throw err;
    }
  }
  return messages;
}

// ---------- Help ----------

const HELP = `khaaka — build Khaaka layout files from the terminal

  khaaka <command> <file.json> [options]

Creating
  new <file> [--name N] [--units ft|m|mm] [--grid LEN] [--box-px N]

Adding objects
  add-room    <file> --at X,Y --size WxH [--label L] [--walls] [--thickness LEN]
                     [--area] [--fill HEX] [--stroke HEX]
  add-wall    <file> --from X,Y --to X,Y [--thickness LEN] [--label L]
  add-door    <file> --at X,Y [--width LEN] [--rot DEG] [--label L]
  add-window  <file> --at X,Y [--width LEN] [--rot DEG] [--label L]
  add-ruler   <file> --wall ID [--offset LEN] [--flip] [--label L]
                     permanent dimension pinned beside a wall; tracks it.
                     Always placed clear of every room; --offset is the gap
                     beyond the last one.
  add-measure <file> --from X,Y --to X,Y [--label L]
  add-polygon <file> --points "X,Y X,Y X,Y ..." [--label L] [--area]
  add-note    <file> --at X,Y --text "..."
                     numbered pin; the text shows when hovered
  add-fixture <file> --kind KIND --at X,Y [--rot DEG] [--label L]
                     KIND: socket | switch | light | gas | water | drain
  add-text    <file> (--at X,Y | --above) --text "..." [--size PX] [--gap LEN]
                     --above finds clear space over the whole drawing

Editing
  remove <file> --id N[,N...]
  move   <file> --id N (--by DX,DY | --to X,Y)
  set    <file> [--name N] [--units U] [--grid LEN] [--box-px N]
                [--show-dims true|false] [--snap true|false] [--wall-thickness LEN]

Inspecting
  list    <file>
  preview <file> [-o out.svg]        writes SVG (stdout if no -o)

Batch
  run <file> <script.khk>            apply a script; "-" reads stdin

Lengths
  Any length or coordinate takes a unit: 3200mm, 250cm, 4.2m, 12ft, 12'6", 6in.
  A bare number is read in the file's own units (see --units), so in an mm
  layout --size 4200x3600 means millimetres.

  Coordinates are absolute: X grows right, Y grows DOWN (screen convention).
  All object positions are the top-left of their bounding box, except walls
  and measures, which take explicit endpoints.

Examples
  khaaka new plan.json --units mm --name "Ground floor"
  khaaka add-room plan.json --at 0,0 --size 4200x3600 --label Living --walls
  khaaka add-door plan.json --at 4200,1200 --width 900 --rot 90
  khaaka run plan.json floor.khk && khaaka preview plan.json -o floor.svg
`;

// ---------- Entry point ----------

function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { process.stdout.write(HELP); return 0; }

  const { flags, positional } = parseArgs(argv.slice(1));
  const file = positional[0];
  if (!file) throw new UserError(`${cmd}: missing layout file. Try: khaaka ${cmd} plan.json …`);

  if (cmd === 'new') {
    known(flags, ['name', 'units', 'grid', 'box-px', 'force'], 'new');
    if (fs.existsSync(file) && flags.force !== true && flags.force !== 'true') {
      throw new UserError(`${file} already exists. Pass --force to overwrite it.`);
    }
    const units = flags.units !== undefined && flags.units !== true ? String(flags.units) : 'm';
    if (!UNITS.includes(units)) throw new UserError(`new: --units must be one of ${UNITS.join(', ')}`);
    const d = blankLayout({
      name: flags.name !== undefined && flags.name !== true ? String(flags.name) : path.basename(file, '.json'),
      units,
      gridSize: flags.grid !== undefined && flags.grid !== true ? parseLen(flags.grid, units) : null,
      boxPx: flags['box-px'] !== undefined && flags['box-px'] !== true ? Number(flags['box-px']) : 25,
    });
    save(file, d);
    console.log(`Created ${file} — "${d.projectName}", units ${d.units}, grid ${fmtLen(d.grid.size, d.units)}`);
    return 0;
  }

  if (cmd === 'list') {
    console.log(list(load(file), file));
    return 0;
  }

  if (cmd === 'preview') {
    known(flags, ['out', 'width'], 'preview');
    const d = load(file);
    const width = flags.width !== undefined && flags.width !== true ? Number(flags.width) : 1200;
    if (!Number.isFinite(width) || width < 100) throw new UserError('preview: --width must be at least 100');
    const svg = toSvg(d, { width });
    if (flags.out) {
      fs.writeFileSync(flags.out, svg + '\n');
      console.log(`Wrote ${flags.out} (${d.objects.length} objects)`);
    } else {
      process.stdout.write(svg + '\n');
    }
    return 0;
  }

  if (cmd === 'run') {
    const script = positional[1];
    if (!script) throw new UserError('run: give a script file, or "-" to read stdin');
    const text = script === '-'
      ? fs.readFileSync(0, 'utf8')
      : fs.readFileSync(script, 'utf8');
    const d = load(file);
    const messages = runScript(d, text, script === '-' ? 'stdin' : script);
    save(file, d);
    console.log(messages.join('\n'));
    console.log(`Applied ${messages.length} command${messages.length === 1 ? '' : 's'} to ${file}`);
    return 0;
  }

  const fn = MUTATORS[cmd];
  if (!fn) throw new UserError(`unknown command "${cmd}". Run khaaka help for the list.`);
  const d = load(file);
  const msg = fn(d, flags);
  save(file, d);
  console.log(msg);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UserError) {
    console.error(`khaaka: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
