/* ===========================================================================
   Eternal — interactive breaking-marble artwork
   ---------------------------------------------------------------------------
   The bust (`eternalv3.png`) is a field of breakable CELLS. When the pointer
   touches a cell it fractures and is permanently cleared from the visible
   sculpture (an erosion mask, kept separate from the original image). The
   shattered matter is thrown into space as a three-stage cascade:

       marble surface → large fragments → small fragments → fine dust → empty hole

   • LARGE fragments  : real textured pieces of the image; fly out first, rotate
                        slowly, then SPLIT into small fragments.
   • SMALL fragments  : smaller textured pieces; scatter faster, then SPLIT into
                        dust.
   • DUST             : fine image-coloured specks; float the longest, swirl with
                        turbulence, fade last.

   Each cell holds a restoration timer: once broken it stays an empty black hole
   for a DELAY, then slowly and smoothly heals back. Breaking a new area does not
   touch the old wounds — they keep restoring on their own clocks.

   Physics: mouse speed = break force (fast → explosions, slow → soft erosion),
   mouse direction is inherited by the fragments, plus drag, turbulence, rotation
   & angular velocity, opacity fade, and no gravity (free drifting in space).
   =========================================================================== */

(() => {
  "use strict";

  // ---- adjustable parameters ----------------------------------------------
  const params = {
    cursorRadius: 100, // px — reach of the breaking field
    density: 50,       // 1..100 — fragment & dust quantity per broken cell
    spread: 55,        // 10..100 — explosion force / travel / turbulence
    restoration: 4,    // 1..100 — heal speed (low = long delay + slow regrow)
    opacity: 95,       // 10..100 — particle brightness
    particleSize: 4,   // 1..5 — fragment / dust scale
  };
  const DEFAULTS = { ...params };

  // ---- DOM ----------------------------------------------------------------
  const canvas = document.getElementById("scene");
  const ctx = canvas.getContext("2d");
  const loader = document.getElementById("loader");

  // ---- offscreen layer ----------------------------------------------------
  // Only the pristine statue is kept offscreen (drawn once per resize). Holes
  // are punched straight onto the screen each frame, so there is just one
  // full-screen blit per frame instead of three.
  const baseCanvas = document.createElement("canvas");   // pristine statue
  const baseCtx = baseCanvas.getContext("2d");

  // ---- state --------------------------------------------------------------
  let W = 0, H = 0, dpr = 1;
  let sourceImg = null;
  let rect = null;
  let basePixels = null, baseW = 0, baseH = 0;

  // ---- breakable grid -----------------------------------------------------
  let cellPx = 0, cols = 0, rows = 0;
  let health = null;     // Float32: 1 = intact marble, 0 = broken (void)
  let cgen = null;       // Uint16: generation, guards stale fracture events
  let onFigure = null;   // Uint8:  1 = this cell sits on the marble
  let active = null;     // Uint8:  1 = currently in the `damaged` list
  let damaged = [];      // indices of broken cells (their void is drawn)

  // ---- pointer (with velocity) --------------------------------------------
  const pointer = {
    x: -9999, y: -9999, px: -9999, py: -9999,
    vx: 0, vy: 0, speed: 0, active: false,
  };

  // ---- particle pools (swap-remove for O(1) deletion) ---------------------
  // Each fracture is recorded as an EVENT: a fixed hierarchy of fragments
  // (large → medium → small → dust) with deterministic trajectories. One
  // timeline drives it forward (explode), holds, then backward (rewind) —
  // restoration is literally the destruction played in reverse.
  const MAX_EVENTS = 1400;
  const MAX_NODES = 60000;   // global cap on restoration pieces (keeps it smooth)
  const events = [];
  let nodeCount = 0;         // total restoration pieces currently alive
  // Visual destruction debris (the explosion look): random-physics shards + dust
  // that fly out and fade. The reverse rebuild itself is handled by `events`.
  const MAX_FRAG = 3000;
  const MAX_DUST = 36000;
  const frags = [];
  const dust = [];

  // ---- helpers ------------------------------------------------------------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const irand = (a, b) => (a + Math.random() * (b - a)) | 0;

  function containRect(iw, ih, bw, bh) {
    const s = Math.min(bw / iw, bh / ih);
    const w = iw * s, h = ih * s;
    return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
  }

  /* Marble colour at a device-pixel coordinate, or null if off-figure/too dark. */
  function sampleColor(sx, sy) {
    if (!basePixels || !rect) return null;
    const u = (sx - rect.x) / rect.w, v = (sy - rect.y) / rect.h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const bx = clamp((u * baseW) | 0, 0, baseW - 1);
    const by = clamp((v * baseH) | 0, 0, baseH - 1);
    const i = (by * baseW + bx) * 4;
    const r = basePixels[i], g = basePixels[i + 1], b = basePixels[i + 2];
    if (r * 0.299 + g * 0.587 + b * 0.114 < 38) return null;
    return [r, g, b];
  }

  // ---- (re)build on resize ------------------------------------------------
  function setup() {
    if (!sourceImg) return;
    const cssW = window.innerWidth, cssH = window.innerHeight;
    // Full resolution (standard retina cap of 2x). The heavy per-frame work was
    // optimised away (no per-fragment clip, single base blit), so no downscale.
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.floor(cssW * dpr);
    H = Math.floor(cssH * dpr);

    [canvas, baseCanvas].forEach((c) => { c.width = W; c.height = H; });
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";

    rect = containRect(sourceImg.width, sourceImg.height, W, H);
    baseCtx.clearRect(0, 0, W, H);
    baseCtx.drawImage(sourceImg, rect.x, rect.y, rect.w, rect.h);

    baseW = Math.min(Math.round(rect.w), 1400);
    const scale = baseW / rect.w;
    baseH = Math.max(1, Math.round(rect.h * scale));
    const tmp = document.createElement("canvas");
    tmp.width = baseW; tmp.height = baseH;
    const tctx = tmp.getContext("2d");
    tctx.drawImage(sourceImg, 0, 0, baseW, baseH);
    basePixels = tctx.getImageData(0, 0, baseW, baseH).data;

    // breakable grid
    cellPx = Math.max(12, Math.round(22 * dpr));
    cols = Math.ceil(W / cellPx);
    rows = Math.ceil(H / cellPx);
    health = new Float32Array(cols * rows).fill(1);
    cgen = new Uint16Array(cols * rows);
    onFigure = new Uint8Array(cols * rows);
    active = new Uint8Array(cols * rows);
    damaged = [];
    events.length = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = (c + 0.5) * cellPx, cy = (r + 0.5) * cellPx;
        if (sampleColor(cx, cy)) onFigure[r * cols + c] = 1;
      }
    }

    events.length = 0;
    nodeCount = 0;
    frags.length = 0;
    dust.length = 0;
  }

  // ---- procedural stone-fracture geometry --------------------------------
  // Returns a unique irregular polygon (normalised to ~unit radius). Random
  // vertex count, irregular angular steps, random elongation and an optional
  // concave notch yield shards, splinters, needles, triangles, kites and
  // jagged convex/concave stone pieces — no two break events look alike.
  function makeShard() {
    const n = 3 + (Math.random() * 5 | 0);               // 3..7 vertices
    const elong = 1 + Math.pow(Math.random(), 2) * 3.4;  // 1 → long splinter
    const phi = Math.random() * Math.PI * 2;             // elongation axis
    const cosP = Math.cos(phi), sinP = Math.sin(phi);
    const concave = Math.random() < 0.4;
    const pts = [];
    let a = Math.random() * Math.PI * 2;
    let maxR = 0.0001;
    for (let i = 0; i < n; i++) {
      a += (Math.PI * 2 / n) * rand(0.5, 1.5);           // irregular spacing
      let r = rand(0.5, 1);
      if (concave && i % 2 === 0) r *= rand(0.3, 0.55);  // notch inward → concave
      let lx = Math.cos(a) * r, ly = Math.sin(a) * r;
      // stretch along phi so some pieces become shards / needles
      const u = lx * cosP + ly * sinP, v = -lx * sinP + ly * cosP;
      const su = u * elong, sv = v / Math.sqrt(elong);
      lx = su * cosP - sv * sinP;
      ly = su * sinP + sv * cosP;
      pts.push([lx, ly]);
      const rr = Math.hypot(lx, ly);
      if (rr > maxR) maxR = rr;
    }
    for (let i = 0; i < n; i++) { pts[i][0] /= maxR; pts[i][1] /= maxR; }
    return pts;
  }

  // deterministic per-cell pseudo-noise → stable jagged hole silhouette
  function cellNoise(idx, i) {
    const s = Math.sin(idx * 12.9898 + i * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  // ---- destruction debris (the explosion you see while breaking) ----------
  function spawnFrag(x, y, vx, vy, ss, stage, col) {
    if (frags.length >= MAX_FRAG) return;
    const poly = makeShard();
    let area = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
      area += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
    const mass = clamp(Math.abs(area) * 0.5, 0.15, 1);
    const sh = rand(0.72, 1.12);
    const r = clamp((col[0] * sh) | 0, 0, 255);
    const g = clamp((col[1] * sh) | 0, 0, 255);
    const b = clamp((col[2] * sh) | 0, 0, 255);
    frags.push({
      x, y, vx, vy, ss, poly, mass,
      rot: Math.random() * Math.PI * 2,
      vrot: rand(-0.22, 0.22) * (stage === "large" ? 1 : 2.2) / (0.5 + mass),
      life: 1,
      decay: (stage === "large" ? rand(0.006, 0.011) : rand(0.012, 0.02)) * (1.2 - mass * 0.4),
      stage, split: false,
      cr: col[0], cg: col[1], cb: col[2],
      fill: `rgb(${r},${g},${b})`,
    });
  }

  function spawnDust(x, y, vx, vy, col) {
    if (dust.length >= MAX_DUST) return;
    dust.push({
      x, y, vx, vy, life: 1,
      decay: rand(0.003, 0.009),
      size: Math.max(1, (params.particleSize - 1) + (Math.random() < 0.5 ? 0 : 1)),
      phase: Math.random() * Math.PI * 2,
      cs: `rgb(${col[0]},${col[1]},${col[2]})`,
    });
  }

  // Throw out the visible explosion for one cell: large shards → small → dust,
  // flung outward from the cursor with inherited mouse momentum.
  function emitDebris(cx, cy, force) {
    const col = sampleColor(cx, cy) || [220, 215, 205];
    const q = lerp(0.4, 1, (params.density - 1) / 99);
    const nLarge = irand(2, 6);
    const nSmall = Math.round(irand(6, 16) * q);
    const nDust = Math.round(irand(30, 80) * q);
    let dx = cx - pointer.x, dy = cy - pointer.y;
    let d = Math.hypot(dx, dy);
    if (d < 1) { const a = Math.random() * 6.283; dx = Math.cos(a); dy = Math.sin(a); d = 1; }
    const nx = dx / d, ny = dy / d;
    const ix = pointer.vx * 0.35, iy = pointer.vy * 0.35;
    const sizeK = params.particleSize / 3;
    const vel = (spdFactor, jitter) => {
      const sp = force * spdFactor * rand(0.5, 1.2);
      return [nx * sp + ix + rand(-jitter, jitter), ny * sp + iy + rand(-jitter, jitter)];
    };
    const jit = cellPx * 0.5;
    for (let i = 0; i < nLarge; i++) {
      const [vx, vy] = vel(0.55, force * 0.3);
      spawnFrag(cx + rand(-jit, jit), cy + rand(-jit, jit), vx, vy, cellPx * rand(0.95, 1.6) * sizeK, "large", col);
    }
    for (let i = 0; i < nSmall; i++) {
      const [vx, vy] = vel(1.0, force * 0.5);
      spawnFrag(cx + rand(-jit, jit), cy + rand(-jit, jit), vx, vy, cellPx * rand(0.4, 0.7) * sizeK, "small", col);
    }
    for (let i = 0; i < nDust; i++) {
      const [vx, vy] = vel(1.35, force * 0.7);
      spawnDust(cx + rand(-cellPx, cellPx) * 0.5, cy + rand(-cellPx, cellPx) * 0.5, vx, vy, col);
    }
  }

  // ---- fracture events (recorded for exact time-reversal) -----------------
  const TA = 0.28, TB = 0.55, TC = 0.78;     // tier phase windows: L | M | S | dust
  const easeOut = (u) => 1 - (1 - u) * (1 - u);

  // Build one cell's fracture: a hierarchy of fragments with fixed trajectories.
  // Every child is born at its parent's end position and thrown further outward;
  // positions/rotations are stored relative to the cell home, so the very same
  // recorded data plays forward (explode) AND backward (rewind).
  function createEvent(idx, cx, cy, dirx, diry, force) {
    if (events.length >= MAX_EVENTS) return false;
    const col = sampleColor(cx, cy) || [210, 205, 196];
    const tt = (params.restoration - 1) / 99;
    const q = lerp(0.5, 1, (params.density - 1) / 99);
    const spread = lerp(0.7, 2.2, (params.spread - 10) / 90);
    const baseAng = Math.atan2(diry, dirx);
    const fillOf = () => {
      const s = rand(0.78, 1.12);
      return `rgb(${clamp(col[0] * s | 0, 0, 255)},${clamp(col[1] * s | 0, 0, 255)},${clamp(col[2] * s | 0, 0, 255)})`;
    };
    const off = (mag) => {
      const a = baseAng + rand(-1.4, 1.4), m = mag * spread;
      return [Math.cos(a) * m, Math.sin(a) * m];
    };
    const nodes = [];
    // every piece starts AT the cell home and is thrown outward; the rewind plays
    // it backward → the piece gathers from out there back into place.
    const mk = (tier, ex, ey, size, p0, p1) => {
      nodes.push({
        tier, sx: 0, sy: 0, ex, ey, size, p0, p1,
        rotS: rand(0, 6.283),
        rotE: rand(0, 6.283) + (Math.random() < 0.5 ? -1 : 1) * rand(1.2, 5),
        fill: fillOf(),
        poly: tier < 3 ? makeShard() : null,
      });
    };
    // restoration is built from MANY small chips + even MORE dust — no big pieces
    let nS = Math.round(lerp(14, 30, q));
    let nD = Math.round(lerp(90, 220, q));
    const budget = Math.max(20, MAX_NODES - nodeCount);
    if (nS + nD > budget) { const k = budget / (nS + nD); nS = (nS * k) | 0; nD = (nD * k) | 0; }
    for (let i = 0; i < nS; i++) {                          // small chips gather last
      const o = off(cellPx * rand(0.5, 1.5));
      mk(2, o[0], o[1], cellPx * rand(0.18, 0.34), 0, 0.72);
    }
    const dsz = Math.max(1, params.particleSize - 2);
    for (let i = 0; i < nD; i++) {                          // dust gathers first
      const o = off(cellPx * rand(0.8, 2.8));
      mk(3, o[0], o[1], dsz, 0.4, 1);
    }
    nodeCount += nodes.length;
    events.push({
      idx, gen: cgen[idx], cx, cy, t0: time, nodes,
      explodeDur: 1.0 * rand(0.85, 1.15),
      holdDur: lerp(8.0, 0.3, tt),           // the void lingers
      rewindDur: lerp(5.0, 1.2, tt),         // calm, deliberate reverse
    });
    return true;
  }

  /* Fracture one cell: open the void and record the event so the restoration
     can replay it backwards (exact reverse physics — not a redraw). */
  function breakCell(idx, cx, cy, force) {
    let dx = cx - pointer.x, dy = cy - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) < 1) { const a = Math.random() * 6.283; dx = Math.cos(a); dy = Math.sin(a); }
    dx += pointer.vx * 0.5; dy += pointer.vy * 0.5;        // inherit mouse momentum
    cgen[idx]++;
    if (!createEvent(idx, cx, cy, dx, dy, force)) return;  // record the reversible fracture
    health[idx] = 0;                                       // open the void
    if (!active[idx]) { active[idx] = 1; damaged.push(idx); }
    emitDebris(cx, cy, force);                             // the visible explosion
  }

  // ---- animation loop -----------------------------------------------------
  let time = 0;

  function frame() {
    time += 0.016;
    const radius = params.cursorRadius * dpr;
    const gOpacity = params.opacity / 100;
    const fdrag = 0.965, sdrag = 0.955, ddrag = 0.985; // large/small/dust drag
    const turb = lerp(0.02, 0.12, (params.spread - 10) / 90) * dpr;

    // --- pointer velocity ---
    pointer.vx = pointer.x - pointer.px;
    pointer.vy = pointer.y - pointer.py;
    const inst = Math.hypot(pointer.vx, pointer.vy);
    pointer.speed = lerp(pointer.speed, inst, 0.5);
    const speedNorm = clamp(pointer.speed / (radius * 0.9), 0, 1);
    // break force: slow movement crumbles gently (bits softly drift away),
    // fast slashes explode. eased curve keeps low speeds soft.
    const force = lerp(0.9, 7, Math.pow(speedNorm, 1.3)) * dpr;

    // --- break cells under the cursor (each cell breaks once until restored) ---
    if (pointer.active) {
      const r2 = radius * radius;
      const c0 = clamp(((pointer.x - radius) / cellPx) | 0, 0, cols - 1);
      const c1 = clamp(((pointer.x + radius) / cellPx) | 0, 0, cols - 1);
      const r0 = clamp(((pointer.y - radius) / cellPx) | 0, 0, rows - 1);
      const r1 = clamp(((pointer.y + radius) / cellPx) | 0, 0, rows - 1);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const idx = r * cols + c;
          if (!onFigure[idx] || health[idx] <= 0.6) continue; // gone / healing
          const cx = (c + 0.5) * cellPx, cy = (r + 0.5) * cellPx;
          const dx = cx - pointer.x, dy = cy - pointer.y;
          if (dx * dx + dy * dy > r2) continue;
          breakCell(idx, cx, cy, force);
        }
      }
    }

    // --- advance fracture events; a finished rewind restores its cell ---
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (time - ev.t0 >= ev.explodeDur + ev.holdDur + ev.rewindDur) {
        if (cgen[ev.idx] === ev.gen) health[ev.idx] = 1;  // void closes → surface back
        nodeCount -= ev.nodes.length;
        events[i] = events[events.length - 1]; events.pop();
      }
    }
    let w = 0;
    for (let i = 0; i < damaged.length; i++) {
      const idx = damaged[i];
      if (health[idx] >= 1) active[idx] = 0;
      else damaged[w++] = idx;
    }
    damaged.length = w;

    // --- draw the sculpture, then punch the holes directly onto the screen ---
    // One full-screen blit (the base), then a small black jagged polygon per
    // damaged cell (alpha = how broken it is). Far cheaper than compositing
    // separate mask/comp layers every frame, especially on large windows.
    // "copy" replaces the whole canvas with the base in a single pass (clears
    // the previous frame + draws the statue at once), saving a full-screen op.
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(baseCanvas, 0, 0);
    ctx.globalCompositeOperation = "source-over";

    ctx.fillStyle = "#050506";
    const nv = 9;
    for (let i = 0; i < damaged.length; i++) {
      const idx = damaged[i];
      const a = 1 - health[idx];
      if (a <= 0.01) continue;
      const c = idx % cols, r = (idx / cols) | 0;
      const cx = (c + 0.5) * cellPx, cy = (r + 0.5) * cellPx;
      const baseR = cellPx * 1.05;
      ctx.globalAlpha = a;
      ctx.beginPath();
      for (let k = 0; k < nv; k++) {
        const ang = (k / nv) * Math.PI * 2 + cellNoise(idx, k + 20) * 0.6;
        const rr = baseR * (0.5 + cellNoise(idx, k) * 0.9);
        const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // --- fracture events: explode forward, hold, then REWIND (time reversal) --
    // Each event samples one timeline. The same recorded fragment trajectories
    // play outward during the explosion and inward during the rewind, so the
    // exact pieces that broke off are the ones that return, in reverse order:
    // dust → small → medium → large → surface.
    for (let e = 0; e < events.length; e++) {
      const ev = events[e];
      const el = time - ev.t0;
      if (el < ev.explodeDur) continue;   // the explosion is drawn by the debris below
      let s;
      if (el < ev.explodeDur) s = el / ev.explodeDur;                 // explode 0→1
      else if (el < ev.explodeDur + ev.holdDur) s = 1;               // hold (void)
      else s = 1 - (el - ev.explodeDur - ev.holdDur) / ev.rewindDur; // rewind 1→0
      if (s < 0) s = 0; else if (s > 1) s = 1;
      const cx = ev.cx, cy = ev.cy, nodes = ev.nodes;
      for (let n = 0; n < nodes.length; n++) {
        const nd = nodes[n];
        if (s < nd.p0 || s > nd.p1) continue;          // only this tier is active
        let u = (s - nd.p0) / (nd.p1 - nd.p0);
        if (u < 0) u = 0; else if (u > 1) u = 1;
        const eu = easeOut(u);
        // cross-dissolve at tier boundaries (merge/split); the root large piece
        // is solid from the surface (no fade-in) so it reconnects seamlessly.
        const fi = nd.tier === 0 ? 1 : (u < 0.12 ? u / 0.12 : 1);
        const fo = (1 - u) < 0.12 ? (1 - u) / 0.12 : 1;
        const a = fi * fo * gOpacity;
        if (a <= 0.01) continue;
        const x = cx + nd.sx + (nd.ex - nd.sx) * eu;
        const y = cy + nd.sy + (nd.ey - nd.sy) * eu;
        const sz = nd.size * (1 - 0.45 * eu);          // grows as it re-forms (reverse)
        ctx.globalAlpha = a;
        ctx.fillStyle = nd.fill;
        if (nd.tier === 3) {
          const d = Math.max(1, sz | 0);
          ctx.fillRect(x | 0, y | 0, d, d);
        } else {
          const rot = nd.rotS + (nd.rotE - nd.rotS) * eu;
          const half = sz * 0.5, poly = nd.poly, co = Math.cos(rot), si = Math.sin(rot);
          ctx.beginPath();
          for (let k = 0; k < poly.length; k++) {
            const lx = poly[k][0] * half, ly = poly[k][1] * half;
            const px = x + lx * co - ly * si, py = y + lx * si + ly * co;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;

    // --- destruction debris: shards tumble, cascade to dust, fly with inertia --
    for (let i = frags.length - 1; i >= 0; i--) {
      const p = frags[i];
      const drag = p.stage === "large" ? fdrag : sdrag;
      p.vx = p.vx * drag + (Math.random() - 0.5) * turb;
      p.vy = p.vy * drag + (Math.random() - 0.5) * turb;
      p.x += p.vx; p.y += p.vy;
      p.rot += p.vrot; p.vrot *= 0.99;
      p.life -= p.decay;
      if (!p.split && p.life < 0.5) {            // cascade: large → small → dust
        p.split = true;
        const col = [p.cr, p.cg, p.cb];
        if (p.stage === "large") {
          const n = irand(2, 5);
          for (let k = 0; k < n; k++)
            spawnFrag(p.x, p.y, p.vx * 1.1 + rand(-1, 1) * dpr, p.vy * 1.1 + rand(-1, 1) * dpr,
              p.ss * rand(0.4, 0.6), "small", col);
        } else {
          const n = irand(3, 6);
          for (let k = 0; k < n; k++)
            spawnDust(p.x, p.y, p.vx * 0.9 + rand(-1.4, 1.4) * dpr, p.vy * 0.9 + rand(-1.4, 1.4) * dpr, col);
        }
      }
      if (p.life <= 0) { frags[i] = frags[frags.length - 1]; frags.pop(); continue; }
      const half = p.ss * (0.5 + p.life * 0.5) * 0.5;
      const poly = p.poly, co = Math.cos(p.rot), si = Math.sin(p.rot), x = p.x, y = p.y;
      ctx.globalAlpha = clamp(p.life * 1.3, 0, 1) * gOpacity;
      ctx.fillStyle = p.fill;
      ctx.beginPath();
      for (let k = 0; k < poly.length; k++) {
        const lx = poly[k][0] * half, ly = poly[k][1] * half;
        const px = x + lx * co - ly * si, py = y + lx * si + ly * co;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (let i = dust.length - 1; i >= 0; i--) {
      const p = dust[i];
      p.phase += 0.12;
      p.vx = p.vx * ddrag + Math.cos(p.phase) * turb * 0.6 + (Math.random() - 0.5) * turb * 0.5;
      p.vy = p.vy * ddrag + Math.sin(p.phase * 1.3) * turb * 0.6 + (Math.random() - 0.5) * turb * 0.5;
      p.x += p.vx; p.y += p.vy;
      p.life -= p.decay;
      if (p.life <= 0) { dust[i] = dust[dust.length - 1]; dust.pop(); continue; }
      ctx.globalAlpha = p.life * gOpacity;
      ctx.fillStyle = p.cs;
      ctx.fillRect(p.x | 0, p.y | 0, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // advance pointer history
    pointer.px = pointer.x;
    pointer.py = pointer.y;

    requestAnimationFrame(frame);
  }

  // ---- pointer input ------------------------------------------------------
  function setPointer(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const x = (clientX - r.left) * dpr;
    const y = (clientY - r.top) * dpr;
    if (!pointer.active) { pointer.px = x; pointer.py = y; pointer.speed = 0; }
    pointer.x = x; pointer.y = y;
    pointer.active = true;
  }

  window.addEventListener("mousemove", (e) => setPointer(e.clientX, e.clientY));
  canvas.addEventListener("mouseleave", () => { pointer.active = false; });
  window.addEventListener("blur", () => { pointer.active = false; });

  const onTouch = (e) => {
    if (e.touches.length) {
      e.preventDefault();
      setPointer(e.touches[0].clientX, e.touches[0].clientY);
    }
  };
  window.addEventListener("touchstart", onTouch, { passive: false });
  window.addEventListener("touchmove", onTouch, { passive: false });
  window.addEventListener("touchend", () => { pointer.active = false; });

  // ---- responsive ---------------------------------------------------------
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(setup, 160);
  });

  // ---- fullscreen (press F) -----------------------------------------------
  function toggleFullscreen() {
    const el = document.documentElement;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) { const p = req.call(el); if (p && p.catch) p.catch(() => {}); }
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    }
  }
  window.addEventListener("keydown", (e) => {
    // ignore when typing in a control; toggle on F
    if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      toggleFullscreen();
    }
  });
  // entering/leaving fullscreen changes the viewport → rebuild buffers
  const onFsChange = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(setup, 60); };
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  // ---- control panel ------------------------------------------------------
  function bindControls() {
    const ids = Object.keys(params);
    ids.forEach((id) => {
      const input = document.getElementById(id);
      const valEl = document.querySelector(`.val[data-for="${id}"]`);
      if (!input) return;
      input.value = params[id];
      if (valEl) valEl.textContent = input.value;
      input.addEventListener("input", () => {
        params[id] = parseFloat(input.value);
        if (valEl) valEl.textContent = input.value;
      });
    });
    document.getElementById("resetBtn").addEventListener("click", () => {
      Object.assign(params, DEFAULTS);
      ids.forEach((id) => {
        const input = document.getElementById(id);
        const valEl = document.querySelector(`.val[data-for="${id}"]`);
        if (input) { input.value = params[id]; if (valEl) valEl.textContent = input.value; }
      });
    });
    const panel = document.getElementById("panel");
    document.getElementById("panelToggle").addEventListener("click", () => {
      panel.classList.toggle("collapsed");
    });
  }

  // ---- "The Swan" — synthesized string-orchestra arrangement ---------------
  // Saint-Saëns' Le Cygne (public domain) in spirit: G major, slow 6/4, the
  // signature rippling arpeggio accompaniment beneath a long, singing string
  // melody with vibrato. An original rendering of the score — not a recording.
  const music = (() => {
    let ac = null, master, comp, filter, delayA, fbA, delayB, fbB;
    let playing = false, timer = null, step = 0, nextTime = 0;
    const BPM = 58, beat = 60 / BPM, stepDur = beat / 2; // eighth-note clock
    const SPB = 12;                                       // eighth-notes per 6/4 bar
    const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
    // 8-bar progression in G major. arp = rippling pool, pad = soft string bed.
    // 4-bar loop: 2 bars of the cello theme, then a 2-bar accompaniment "breath"
    const bars = [
      { bass: 43, pad: [55, 59, 62],     arp: [55, 59, 62, 67, 71, 74] }, // G (theme)
      { bass: 43, pad: [55, 59, 62],     arp: [55, 59, 62, 67, 71, 74] }, // G (theme)
      { bass: 38, pad: [50, 54, 57, 60], arp: [50, 54, 57, 60, 62, 66] }, // D7 (breath)
      { bass: 43, pad: [55, 59, 62],     arp: [55, 59, 62, 67, 71, 74] }, // G (breath/resolve)
    ];
    const ripple = [0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0]; // up-then-down per bar
    const LOOP = bars.length * SPB;                       // 48 eighth-notes
    // Cello melody — Saint-Saëns' "The Swan" opening, the exact note sequence:
    //   D – G – G – G – F# – G  |  B – A – G – B – D
    // [stepInLoop, midi, durationInEighths], in the cello's tenor register.
    const melodySeq = [
      [0, 62, 2], [2, 67, 4], [6, 67, 2], [8, 67, 1], [9, 66, 1], [10, 67, 2], // D G(long) G G F# G
      [12, 71, 2], [14, 69, 2], [16, 67, 2], [18, 71, 2], [20, 74, 4],         // B A G B D(long)
      // bars 3–4: the cello rests; only the rippling accompaniment breathes
    ];
    const melAt = {};
    melodySeq.forEach(([s, n, d]) => { melAt[s] = [n, d]; });

    function build() {
      const AC = window.AudioContext || window.webkitAudioContext;
      ac = new AC();
      master = ac.createGain(); master.gain.value = 0.0001;
      comp = ac.createDynamicsCompressor();
      filter = ac.createBiquadFilter();
      filter.type = "lowpass"; filter.frequency.value = 2700; filter.Q.value = 0.5;
      // two delay taps → a warm concert-hall reverberation
      delayA = ac.createDelay(2); delayA.delayTime.value = 0.4; fbA = ac.createGain(); fbA.gain.value = 0.38;
      delayB = ac.createDelay(2); delayB.delayTime.value = 0.7; fbB = ac.createGain(); fbB.gain.value = 0.32;
      filter.connect(master);
      filter.connect(delayA); delayA.connect(fbA); fbA.connect(delayA); delayA.connect(master);
      filter.connect(delayB); delayB.connect(fbB); fbB.connect(delayB); delayB.connect(master);
      master.connect(comp); comp.connect(ac.destination);
    }

    function adsr(g, t, atk, dur, vel) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vel, t + atk);
      g.gain.setValueAtTime(vel, t + Math.max(atk + 0.05, dur * 0.7));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }

    // singing cello melody: warm bowed tone (saw ensemble + sine core) + vibrato
    function strings(freq, t, dur, vel) {
      const g = ac.createGain(); adsr(g, t, 0.16, dur + 0.18, vel); g.connect(filter);
      const lp = ac.createBiquadFilter(); lp.type = "lowpass";
      lp.frequency.value = Math.min(2600, freq * 5 + 500); lp.Q.value = 0.7; lp.connect(g);
      const lfo = ac.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 5.0;
      const lg = ac.createGain(); lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(6, t + 0.6);
      lfo.connect(lg); lfo.start(t); lfo.stop(t + dur + 0.35);
      [-5, 5].forEach((d) => {
        const o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = freq; o.detune.value = d;
        lg.connect(o.detune); o.connect(lp); o.start(t); o.stop(t + dur + 0.35);
      });
      // warm sine fundamental for body
      const og = ac.createGain(); og.gain.value = 0.55; og.connect(g);
      const os = ac.createOscillator(); os.type = "sine"; os.frequency.value = freq;
      lg.connect(os.detune); os.connect(og); os.start(t); os.stop(t + dur + 0.35);
    }
    // soft sustained string bed
    function pad(freq, t, dur, vel) {
      const g = ac.createGain(); adsr(g, t, 1.4, dur, vel); g.connect(filter);
      [-7, 7].forEach((d) => {
        const o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = freq; o.detune.value = d;
        o.connect(g); o.start(t); o.stop(t + dur + 0.2);
      });
    }
    // rippling accompaniment note (harp/pizzicato-like)
    function ripplePluck(freq, t, vel) {
      const dur = stepDur * 2.4;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vel, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      g.connect(filter);
      const o = ac.createOscillator(); o.type = "triangle"; o.frequency.value = freq;
      o.connect(g); o.start(t); o.stop(t + dur + 0.1);
    }
    // deep cello low register — warm, bowed, rich (saw ensemble + sine) + vibrato
    function bass(freq, t, dur, vel) {
      const g = ac.createGain(); adsr(g, t, 0.25, dur, vel); g.connect(filter);
      const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1100; lp.Q.value = 0.8; lp.connect(g);
      const lfo = ac.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 4.6;
      const lg = ac.createGain(); lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(5, t + 0.8);
      lfo.connect(lg); lfo.start(t); lfo.stop(t + dur + 0.3);
      [-4, 4].forEach((d) => {
        const o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = freq; o.detune.value = d;
        lg.connect(o.detune); o.connect(lp); o.start(t); o.stop(t + dur + 0.3);
      });
      const og = ac.createGain(); og.gain.value = 0.7; og.connect(g);
      const os = ac.createOscillator(); os.type = "sine"; os.frequency.value = freq; os.connect(og); os.start(t); os.stop(t + dur + 0.3);
    }

    function schedule() {
      while (nextTime < ac.currentTime + 0.3) {
        const s = step % LOOP;
        const bar = bars[(s / SPB) | 0];
        const b = s % SPB;
        const barDur = stepDur * SPB;
        // continuous rippling arpeggio — one note each eighth
        const pool = bar.arp;
        ripplePluck(mtof(pool[ripple[b] % pool.length]), nextTime, 0.05);
        // bar start: soft bass + warm sustained string bed
        if (b === 0) {
          bass(mtof(bar.bass), nextTime, barDur * 1.02, 0.15);       // deep cello
          bar.pad.forEach((m) => pad(mtof(m), nextTime, barDur * 1.05, 0.016));
        }
        // the singing cello melody
        const mo = melAt[s];
        if (mo) strings(mtof(mo[0]), nextTime, mo[1] * stepDur, 0.16);
        step++;
        nextTime += stepDur;
      }
    }

    function play() {
      if (!ac) build();
      if (ac.state === "suspended") ac.resume();
      if (!timer) { nextTime = ac.currentTime + 0.15; timer = setInterval(schedule, 60); }
      playing = true;
      master.gain.cancelScheduledValues(ac.currentTime);
      master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), ac.currentTime);
      master.gain.linearRampToValueAtTime(0.3, ac.currentTime + 3.0); // gentle swell-in
    }

    function mute() {
      if (!ac) return;
      master.gain.cancelScheduledValues(ac.currentTime);
      master.gain.setValueAtTime(master.gain.value, ac.currentTime);
      master.gain.linearRampToValueAtTime(0.0001, ac.currentTime + 0.7);
      if (timer) { clearInterval(timer); timer = null; }
      playing = false;
    }

    return {
      play, mute,
      toggle() { playing ? mute() : play(); return playing; },
      get playing() { return playing; },
    };
  })();

  // ---- background track ---------------------------------------------------
  // If a real recording file "the-swan.mp3" sits next to index.html, play THAT
  // (sounds exactly like the recording). Otherwise fall back to the synth.
  const VOL = 0.85;
  const swanFile = new Audio("the-swan.mp3");
  swanFile.loop = true; swanFile.preload = "auto"; swanFile.volume = 0;
  let fileReady = false;
  swanFile.addEventListener("canplaythrough", () => { fileReady = true; });
  swanFile.addEventListener("error", () => { fileReady = false; });

  let fileFade = null;
  function fadeFile(target, done) {
    clearInterval(fileFade);
    fileFade = setInterval(() => {
      const v = swanFile.volume;
      if (Math.abs(target - v) <= 0.04) {
        swanFile.volume = Math.max(0, Math.min(1, target));
        clearInterval(fileFade);
        if (done) done();
      } else {
        swanFile.volume = Math.max(0, Math.min(1, v + (target > v ? 0.04 : -0.04)));
      }
    }, 70);
  }

  // controller that prefers the recording, else the synth
  const track = {
    playing: false,
    play() {
      this.playing = true;
      if (fileReady) {
        swanFile.play()
          .then(() => fadeFile(VOL))
          .catch(() => music.play());   // autoplay/format issue → synth
      } else {
        music.play();
      }
    },
    mute() {
      this.playing = false;
      if (!swanFile.paused) fadeFile(0, () => swanFile.pause());
      music.mute();
    },
    toggle() { this.playing ? this.mute() : this.play(); return this.playing; },
  };

  // sound button + M key, and auto-start on the first user gesture
  const soundBtn = document.getElementById("soundToggle");
  function reflectSound() { if (soundBtn) soundBtn.classList.toggle("muted", !track.playing); }
  if (soundBtn) soundBtn.addEventListener("click", () => { track.toggle(); reflectSound(); });
  window.addEventListener("keydown", (e) => {
    if ((e.key === "m" || e.key === "M") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); track.toggle(); reflectSound();
    }
  });
  let audioKicked = false;
  function kickAudio() {
    if (audioKicked) return;
    audioKicked = true;
    track.play(); reflectSound();
  }
  ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, kickAudio));

  // ---- boot ---------------------------------------------------------------
  function start() {
    bindControls();
    setup();
    loader.classList.add("hidden");
    requestAnimationFrame(frame);
  }

  const img = new Image();
  img.onload = () => { sourceImg = img; start(); };
  img.onerror = () => {
    loader.querySelector("span").textContent =
      "could not load eternalv3.png — run from a local server";
  };
  img.src = "eternalv3.png";
})();
