/* Khaaka plan viewer — read-only.
 *
 * Renders a Khaaka layout file and nothing else: no tools, no selection, no
 * editing paths at all. Pan, zoom and hover-to-measure are the whole feature
 * set, so the drawing cannot be altered from this page.
 *
 * The rendering is ported from the editor so both draw the plan identically.
 */

(() => {
  'use strict';

  const M_PER_FT = 0.3048;
  const HOVER_RED = '#d61f3f';
  const WALL_STROKE = '#4a2e1c';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const view = { x: 60, y: 60, zoom: 1 };

  let plan = null;
  let hover = null;          // { kind, id, wallId?, text, seg?, sx, sy }
  let panning = null;

  // ---------- Units ----------

  const fmt = (n) => (Math.round(n * 100) / 100).toString();

  function fmtLen(m) {
    const u = plan.units;
    if (u === 'ft') {
      const totalIn = (m / M_PER_FT) * 12;
      let ft = Math.trunc(totalIn / 12);
      let inches = Math.round((totalIn - ft * 12) * 100) / 100;
      if (inches >= 12) { ft += 1; inches -= 12; }
      return `${ft}'-${inches}"`;
    }
    if (u === 'mm') return `${Math.round(m * 1000)} mm`;
    return `${fmt(m)} m`;
  }

  function fmtArea(m2) {
    if (plan.units === 'ft') {
      const sqft = m2 / (M_PER_FT * M_PER_FT);
      return `${(sqft >= 1 ? Math.round(sqft) : Math.round(sqft * 10) / 10).toLocaleString('en-US')} sq ft`;
    }
    return `${m2 < 100 ? Math.round(m2 * 100) / 100 : Math.round(m2 * 10) / 10} m²`;
  }

  // ---------- Space ----------

  const scale = () => plan.pxPerMeter * view.zoom;
  const toScreen = (wx, wy) => ({ x: wx * scale() + view.x, y: wy * scale() + view.y });
  const toWorld = (sx, sy) => ({ x: (sx - view.x) / scale(), y: (sy - view.y) / scale() });

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  const polygonArea = (pts) => {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    }
    return Math.abs(a / 2);
  };

  function polygonCentroid(pts) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const f = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
      a += f; cx += (pts[j].x + pts[i].x) * f; cy += (pts[j].y + pts[i].y) * f;
    }
    if (Math.abs(a) < 1e-9) return pts[0];
    a *= 0.5;
    return { x: cx / (6 * a), y: cy / (6 * a) };
  }

  const rectOverlap = (a, b) => {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return (w > 0 && h > 0) ? w * h : 0;
  };

  // A room's own area minus whatever later rooms cover, so nested things like
  // the closets inside the hall are not counted twice.
  function netArea(o) {
    if (o.type === 'polygon') return polygonArea(o.points || []);
    if (o.type !== 'room') return 0;
    let area = o.w * o.h;
    const idx = plan.objects.indexOf(o);
    for (let i = idx + 1; i < plan.objects.length; i++) {
      const other = plan.objects[i];
      if (other.type === 'room') area -= rectOverlap(o, other);
    }
    return Math.max(0, area);
  }

  function bounds(o) {
    switch (o.type) {
      case 'room': return { x: o.x, y: o.y, w: o.w, h: o.h };
      case 'polygon': {
        const pts = o.points || [];
        if (!pts.length) return null;
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        return { x: Math.min(...xs), y: Math.min(...ys),
                 w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      }
      case 'wall':
      case 'measure':
        return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2),
                 w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
      case 'ruler': {
        const L = rulerLine(o);
        if (!L) return null;
        return { x: Math.min(L.ax, L.bx), y: Math.min(L.ay, L.by),
                 w: Math.abs(L.bx - L.ax), h: Math.abs(L.by - L.ay) };
      }
      case 'door':
      case 'window': {
        const rad = (o.rot || 0) * Math.PI / 180;
        const ex = o.x + Math.cos(rad) * o.w, ey = o.y + Math.sin(rad) * o.w;
        return { x: Math.min(o.x, ex), y: Math.min(o.y, ey),
                 w: Math.abs(ex - o.x), h: Math.abs(ey - o.y) };
      }
      case 'text': return { x: o.x, y: o.y - 0.3, w: 0.2 * (o.text || '').length, h: 0.4 };
      default: return null;
    }
  }

  function planBounds() {
    const boxes = plan.objects.map(bounds).filter(Boolean);
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    const x2 = Math.max(...boxes.map(b => b.x + b.w)), y2 = Math.max(...boxes.map(b => b.y + b.h));
    return { x, y, w: x2 - x, h: y2 - y };
  }

  // ---------- Rulers ----------

  function syncRulers() {
    for (const o of plan.objects) {
      if (o.type !== 'ruler' || o.wallId == null) continue;
      const wall = plan.objects.find(x => x.id === o.wallId && x.type === 'wall');
      if (!wall) continue;
      o.x1 = wall.x1; o.y1 = wall.y1; o.x2 = wall.x2; o.y2 = wall.y2;
    }
  }

  function rulerLine(o) {
    const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const nx = -dy / len, ny = dx / len;
    const off = o.offset || 0;
    return { len, nx, ny,
             ax: o.x1 + nx * off, ay: o.y1 + ny * off,
             bx: o.x2 + nx * off, by: o.y2 + ny * off };
  }

  // ---------- Hover ----------

  // The stretch of a wall the pointer is on, cut short by any opening on it
  // and by any other wall that meets or crosses it.
  function wallPieceAt(wall, wx, wy) {
    const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const ux = dx / len, uy = dy / len;
    const along = (px, py) => (px - wall.x1) * ux + (py - wall.y1) * uy;
    const across = (px, py) => Math.abs((px - wall.x1) * -uy + (py - wall.y1) * ux);
    const thick = wall.thickness || plan.defaultWallThickness;
    const tolPerp = thick / 2 + 8 / scale();

    const cuts = [];
    for (const o of plan.objects) {
      if (o.type !== 'door' && o.type !== 'window') continue;
      const rad = (o.rot || 0) * Math.PI / 180;
      const ex = o.x + Math.cos(rad) * o.w, ey = o.y + Math.sin(rad) * o.w;
      if (across(o.x, o.y) > tolPerp || across(ex, ey) > tolPerp) continue;
      let a = along(o.x, o.y), b = along(ex, ey);
      if (a > b) { const t = a; a = b; b = t; }
      if (b <= 0 || a >= len) continue;
      cuts.push([Math.max(0, a), Math.min(len, b)]);
    }
    for (const o of plan.objects) {
      if (o.type !== 'wall' || o === wall || o.hidden) continue;
      const ox = o.x2 - o.x1, oy = o.y2 - o.y1;
      const olen = Math.hypot(ox, oy);
      if (olen < 1e-9) continue;
      const denom = ux * oy - uy * ox;
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((o.x1 - wall.x1) * oy - (o.y1 - wall.y1) * ox) / denom;
      const u = ((o.x1 - wall.x1) * uy - (o.y1 - wall.y1) * ux) / denom;
      if (u < -1e-6 || u > olen + 1e-6) continue;
      if (t < 0 || t > len) continue;
      const sinA = Math.abs(denom) / olen;
      const half = ((o.thickness || plan.defaultWallThickness) / 2) / Math.max(0.2, sinA);
      cuts.push([Math.max(0, t - half), Math.min(len, t + half)]);
    }
    cuts.sort((p, q) => p[0] - q[0]);

    const piece = (a, b) => (b - a < 1e-6) ? null : {
      x1: wall.x1 + ux * a, y1: wall.y1 + uy * a,
      x2: wall.x1 + ux * b, y2: wall.y1 + uy * b,
      len: b - a, thickness: thick,
    };

    const tp = Math.max(0, Math.min(len, along(wx, wy)));
    let start = 0;
    for (const [a, b] of cuts) {
      if (tp < a) return piece(start, a);
      if (tp <= b) return null;
      start = Math.max(start, b);
    }
    return piece(start, len);
  }

  function hitRuler(wx, wy, coarse) {
    const tol = (coarse ? 24 : 9) / scale();
    const p = toScreen(wx, wy);
    for (let i = plan.objects.length - 1; i >= 0; i--) {
      const o = plan.objects[i];
      if (o.type !== 'ruler' || o.hidden) continue;
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

  function computeHover(wx, wy, sx, sy, coarse) {
    const grab = coarse ? 22 : 7;
    const tol = grab / scale();
    for (let i = plan.objects.length - 1; i >= 0; i--) {
      const o = plan.objects[i];
      if (o.hidden) continue;
      if (o.type === 'door' || o.type === 'window') {
        const rad = (o.rot || 0) * Math.PI / 180;
        const ex = o.x + Math.cos(rad) * o.w, ey = o.y + Math.sin(rad) * o.w;
        if (distToSegment(wx, wy, o.x, o.y, ex, ey) <= tol) {
          return { kind: o.type, id: o.id, text: fmtLen(o.w), sx, sy,
                   seg: { x1: o.x, y1: o.y, x2: ex, y2: ey, thickness: 0 } };
        }
      } else if (o.type === 'measure') {
        if (distToSegment(wx, wy, o.x1, o.y1, o.x2, o.y2) <= tol) {
          return { kind: 'measure', id: o.id,
                   text: fmtLen(Math.hypot(o.x2 - o.x1, o.y2 - o.y1)), sx, sy,
                   seg: { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, thickness: 0 } };
        }
      }
    }
    for (let i = plan.objects.length - 1; i >= 0; i--) {
      const o = plan.objects[i];
      if (o.type !== 'wall' || o.hidden) continue;
      const half = (o.thickness || plan.defaultWallThickness) / 2;
      if (distToSegment(wx, wy, o.x1, o.y1, o.x2, o.y2) > half + tol) continue;
      const piece = wallPieceAt(o, wx, wy);
      if (piece) return { kind: 'wall', id: o.id, text: fmtLen(piece.len), seg: piece, sx, sy };
    }
    const r = hitRuler(wx, wy, coarse);
    if (r) {
      const L = rulerLine(r);
      return { kind: 'ruler', id: r.id, wallId: r.wallId, text: fmtLen(L ? L.len : 0), sx, sy };
    }
    return null;
  }

  const hoveredRulerWallId = () => (hover && hover.kind === 'ruler') ? hover.wallId : null;

  // ---------- Drawing ----------

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawDimension(x1, y1, x2, y2, label, color) {
    const a = toScreen(x1, y1), b = toScreen(x2, y2);
    ctx.save();
    ctx.strokeStyle = color || '#5b6478';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    const tick = 5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - tick); ctx.lineTo(a.x, a.y + tick);
    ctx.moveTo(b.x, b.y - tick); ctx.lineTo(b.x, b.y + tick);
    ctx.stroke();

    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 8) { ctx.restore(); return null; }
    let angle = Math.atan2(dy, dx);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width;
    const padX = 5, padY = 2, h = 14;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = color || '#c8cdd6';
    ctx.lineWidth = color ? 1.5 : 1;
    roundRect(ctx, -w / 2 - padX, -h / 2 - padY, w + padX * 2, h + padY * 2, 4);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = color || '#1c2433';
    ctx.fillText(label, 0, 0);
    ctx.restore();
    return { cx, cy, angle, halfW: w / 2 + padX, halfH: h / 2 + padY };
  }

  function drawGrid(r) {
    if (!plan.grid || !plan.grid.show) return;
    const s = scale();
    const step = plan.grid.size * s;
    if (step < 6) return;
    ctx.strokeStyle = '#e3e7ef';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = view.x % step; x < r.width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, r.height); }
    for (let y = view.y % step; y < r.height; y += step) { ctx.moveTo(0, y); ctx.lineTo(r.width, y); }
    ctx.stroke();
    const major = step * 5;
    ctx.strokeStyle = '#c7cfdd';
    ctx.beginPath();
    for (let x = view.x % major; x < r.width; x += major) { ctx.moveTo(x, 0); ctx.lineTo(x, r.height); }
    for (let y = view.y % major; y < r.height; y += major) { ctx.moveTo(0, y); ctx.lineTo(r.width, y); }
    ctx.stroke();
  }

  function drawObject(o) {
    const s = scale();
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (o.type === 'room') {
      const p = toScreen(o.x, o.y);
      ctx.fillStyle = o.fill; ctx.strokeStyle = o.stroke; ctx.lineWidth = o.strokeWidth;
      ctx.fillRect(p.x, p.y, o.w * s, o.h * s);
      ctx.strokeRect(p.x, p.y, o.w * s, o.h * s);
      if (o.label) {
        ctx.fillStyle = '#1c2433';
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(o.label, p.x + o.w * s / 2, p.y + o.h * s / 2);
      }
      if (o.showArea) {
        const fx = (o.areaPos && typeof o.areaPos.fx === 'number') ? o.areaPos.fx : 0.5;
        const fy = (o.areaPos && typeof o.areaPos.fy === 'number') ? o.areaPos.fy : (o.label ? 0.66 : 0.5);
        ctx.fillStyle = '#475569';
        ctx.font = '500 11px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(fmtArea(o.w * o.h), p.x + fx * o.w * s, p.y + fy * o.h * s);
      }
    } else if (o.type === 'polygon') {
      const pts = o.points || [];
      if (pts.length >= 2) {
        ctx.beginPath();
        const first = toScreen(pts[0].x, pts[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < pts.length; i++) {
          const sp = toScreen(pts[i].x, pts[i].y);
          ctx.lineTo(sp.x, sp.y);
        }
        if (o.closed) { ctx.closePath(); ctx.fillStyle = o.fill || '#e8f0ff'; ctx.fill(); }
        ctx.strokeStyle = o.stroke || '#1f3a8a';
        ctx.lineWidth = o.strokeWidth || 2;
        ctx.stroke();
        if (o.closed && (o.label || o.showArea)) {
          const c = polygonCentroid(pts);
          if (o.label) {
            const sp = toScreen(c.x, c.y);
            ctx.fillStyle = '#1c2433';
            ctx.font = '600 13px system-ui, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(o.label, sp.x, sp.y);
          }
          if (o.showArea) {
            const ax = (o.areaPos && typeof o.areaPos.x === 'number') ? o.areaPos.x : c.x;
            const ay = (o.areaPos && typeof o.areaPos.y === 'number') ? o.areaPos.y : (o.label ? c.y + 0.25 : c.y);
            const sp = toScreen(ax, ay);
            ctx.fillStyle = '#475569';
            ctx.font = '500 11px ui-monospace, Menlo, monospace';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(fmtArea(polygonArea(pts)), sp.x, sp.y);
          }
        }
      }
    } else if (o.type === 'wall') {
      const a = toScreen(o.x1, o.y1), b = toScreen(o.x2, o.y2);
      ctx.strokeStyle = (o.id === hoveredRulerWallId()) ? HOVER_RED : (o.stroke || WALL_STROKE);
      ctx.lineWidth = (o.thickness || plan.defaultWallThickness) * s;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (o.type === 'door') {
      const p = toScreen(o.x, o.y), w = o.w * s;
      ctx.translate(p.x, p.y);
      ctx.rotate((o.rot || 0) * Math.PI / 180);
      ctx.strokeStyle = o.stroke || '#874f0e';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, w, 0, -Math.PI / 2, true); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -w); ctx.stroke();
    } else if (o.type === 'window') {
      const p = toScreen(o.x, o.y), w = o.w * s;
      ctx.translate(p.x, p.y);
      ctx.rotate((o.rot || 0) * Math.PI / 180);
      ctx.fillStyle = '#cfe6ff';
      ctx.strokeStyle = o.stroke || '#1f3a8a';
      ctx.lineWidth = 2;
      ctx.fillRect(0, -4, w, 8);
      ctx.strokeRect(0, -4, w, 8);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.stroke();
    } else if (o.type === 'text') {
      const p = toScreen(o.x, o.y);
      ctx.fillStyle = o.fill || '#1c2433';
      ctx.font = `${(o.size || 14)}px system-ui, sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(o.text || '', p.x, p.y);
    } else if (o.type === 'measure') {
      const a = toScreen(o.x1, o.y1), b = toScreen(o.x2, o.y2);
      ctx.strokeStyle = '#64748b'; ctx.fillStyle = '#475569';
      ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(fmtLen(Math.hypot(o.x2 - o.x1, o.y2 - o.y1)), (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 6);
    } else if (o.type === 'ruler') {
      const L = rulerLine(o);
      if (L) {
        const hot = !!hover && hover.kind === 'ruler' && hover.id === o.id;
        const a0 = toScreen(o.x1, o.y1), b0 = toScreen(o.x2, o.y2);
        const a1 = toScreen(L.ax, L.ay), b1 = toScreen(L.bx, L.by);
        ctx.strokeStyle = hot ? HOVER_RED : (o.stroke || '#8a93a6');
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (const [p0, p1] of [[a0, a1], [b0, b1]]) {
          const vx = p1.x - p0.x, vy = p1.y - p0.y;
          const d = Math.hypot(vx, vy);
          if (d < 8) continue;
          const ux = vx / d, uy = vy / d;
          ctx.moveTo(p0.x + ux * 4, p0.y + uy * 4);
          ctx.lineTo(p0.x + ux * (d + 6), p0.y + uy * (d + 6));
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        const text = o.label ? `${o.label}  ${fmtLen(L.len)}` : fmtLen(L.len);
        o._rulerLabel = drawDimension(L.ax, L.ay, L.bx, L.by, text, hot ? HOVER_RED : null);
        return;
      }
    }
    ctx.restore();
  }

  function drawHoverReadout() {
    if (!hover) return;
    ctx.save();
    if (hover.seg) {
      const a = toScreen(hover.seg.x1, hover.seg.y1);
      const b = toScreen(hover.seg.x2, hover.seg.y2);
      // Dashed for a measure line: it annotates a span, and drawing it as a
      // solid bar makes empty space look like fabric that is not there.
      if (hover.kind === 'measure') ctx.setLineDash([6, 4]);
      ctx.strokeStyle = HOVER_RED;
      ctx.lineWidth = Math.max(3, (hover.seg.thickness || 0) * scale());
      ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(hover.text).width;
    const padX = 6, padY = 3, h = 14;
    const r = canvas.getBoundingClientRect();
    let x = hover.sx + 16, y = hover.sy - 16;
    if (x + w + padX * 2 > r.width) x = hover.sx - 16 - w - padX * 2;
    if (y - h / 2 - padY < 0) y = hover.sy + 20;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = HOVER_RED;
    ctx.lineWidth = 1.5;
    roundRect(ctx, x - padX, y - h / 2 - padY, w + padX * 2, h + padY * 2, 4);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = HOVER_RED;
    ctx.fillText(hover.text, x, y);
    ctx.restore();
  }

  function draw() {
    const r = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    const grad = ctx.createLinearGradient(0, 0, 0, r.height);
    grad.addColorStop(0, '#f7f8fb');
    grad.addColorStop(1, '#eef1f6');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, r.width, r.height);
    drawGrid(r);
    syncRulers();
    for (const o of plan.objects) if (o.type !== 'ruler' && !o.hidden) drawObject(o);
    // Rulers last so nothing buries their labels.
    for (const o of plan.objects) if (o.type === 'ruler' && !o.hidden) drawObject(o);
    drawHoverReadout();
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function fit() {
    const box = planBounds();
    const r = canvas.getBoundingClientRect();
    if (!box || !r.width) return;
    const pad = 40;
    const z = Math.min((r.width - pad * 2) / (box.w * plan.pxPerMeter),
                       (r.height - pad * 2) / (box.h * plan.pxPerMeter));
    view.zoom = Math.max(0.05, Math.min(8, z));
    view.x = (r.width - box.w * plan.pxPerMeter * view.zoom) / 2 - box.x * plan.pxPerMeter * view.zoom;
    view.y = (r.height - box.h * plan.pxPerMeter * view.zoom) / 2 - box.y * plan.pxPerMeter * view.zoom;
    draw();
  }

  // ---------- Input: look, don't touch ----------
  // Pointer events so a finger works the same as a mouse: drag to pan, pinch
  // to zoom, tap to measure. Nothing here can alter the plan.

  const clampZoom = (z) => Math.max(0.05, Math.min(8, z));
  const ptFor = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const pointers = new Map();
  let gesture = null;
  const TAP_SLOP = 6;      // px of travel still counted as a tap, not a drag

  function setHover(sx, sy, coarse) {
    const w = toWorld(sx, sy);
    const next = computeHover(w.x, w.y, sx, sy, coarse);
    const changed = (next && hover)
      ? (next.id !== hover.id || next.kind !== hover.kind || next.text !== hover.text
         || next.sx !== hover.sx || next.sy !== hover.sy)
      : (next !== hover);
    if (changed) { hover = next; draw(); }
    return next;
  }

  function zoomAbout(sx, sy, factor) {
    const before = toWorld(sx, sy);
    view.zoom = clampZoom(view.zoom * factor);
    const after = toWorld(sx, sy);
    view.x += (after.x - before.x) * scale();
    view.y += (after.y - before.y) * scale();
    draw();
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, ptFor(e));
    const pts = [...pointers.values()];
    if (pointers.size === 1) {
      gesture = { mode: 'pan', from: pts[0], vx: view.x, vy: view.y, moved: 0,
                  touch: e.pointerType !== 'mouse' };
      canvas.style.cursor = 'grabbing';
    } else if (pointers.size === 2) {
      const [a, b] = pts;
      gesture = { mode: 'pinch', dist: Math.hypot(b.x - a.x, b.y - a.y), zoom: view.zoom };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = ptFor(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

    if (gesture && gesture.mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (gesture.dist > 1) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const target = clampZoom(gesture.zoom * (dist / gesture.dist));
        zoomAbout(mid.x, mid.y, target / view.zoom);
      }
      return;
    }

    if (gesture && gesture.mode === 'pan') {
      const dx = p.x - gesture.from.x, dy = p.y - gesture.from.y;
      gesture.moved = Math.max(gesture.moved, Math.hypot(dx, dy));
      if (gesture.moved > TAP_SLOP) {
        view.x = gesture.vx + dx;
        view.y = gesture.vy + dy;
        draw();
      }
      return;
    }

    if (e.pointerType === 'mouse') {
      const hit = setHover(p.x, p.y, false);
      canvas.style.cursor = hit ? 'pointer' : 'grab';
    }
  });

  function endPointer(e) {
    const p = pointers.get(e.pointerId) || ptFor(e);
    pointers.delete(e.pointerId);
    // A tap rather than a drag: measure whatever is under the finger and
    // leave the readout up until the next tap.
    if (gesture && gesture.mode === 'pan' && gesture.moved <= TAP_SLOP) {
      setHover(p.x, p.y, !!gesture.touch);
    }
    if (pointers.size === 0) {
      gesture = null;
      canvas.style.cursor = 'grab';
    } else if (pointers.size === 1) {
      const [only] = [...pointers.values()];
      gesture = { mode: 'pan', from: only, vx: view.x, vy: view.y, moved: 0, touch: true };
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && hover) { hover = null; draw(); }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = ptFor(e);
    zoomAbout(p.x, p.y, Math.exp(-e.deltaY * 0.0016));
  }, { passive: false });

  document.getElementById('zoom-in').addEventListener('click', () => {
    const r = canvas.getBoundingClientRect();
    zoomAbout(r.width / 2, r.height / 2, 1.25);
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    const r = canvas.getBoundingClientRect();
    zoomAbout(r.width / 2, r.height / 2, 1 / 1.25);
  });

  document.getElementById('fit').addEventListener('click', fit);
  window.addEventListener('resize', resize);

  // ---------- Boot ----------

  fetch('plan.json?v=3')
    .then(res => res.json())
    .then(data => {
      plan = data;
      plan.defaultWallThickness = plan.defaultWallThickness || 0.1;
      const total = plan.objects.reduce((sum, o) => sum + netArea(o), 0);
      document.getElementById('total').textContent = fmtArea(total);
      document.getElementById('meta').textContent = plan.projectName || '';
      resize();
      fit();
    })
    .catch(err => {
      document.getElementById('meta').textContent = 'Could not load plan.json';
      console.error(err);
    });
})();
