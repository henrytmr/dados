// dice-freeze.mjs — server-authoritative dice settle: detect, remap, verify, jitter, atomic commit.
// Pure ES module, no dependencies. Quaternions are {x,y,z,w}; vectors are [x,y,z].

const DEG = Math.PI / 180;

/* ───────────────────────── vector / quaternion math ───────────────────────── */

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const n = norm(a);
  if (!Number.isFinite(n) || n < 1e-12) throw new RangeError('zero/invalid vector');
  return [a[0] / n, a[1] / n, a[2] / n];
};

export function normalizeQuat(q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(n) || n < 1e-12) throw new RangeError('invalid quaternion');
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}
export const conj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export const mulQuat = (a, b) => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
export function rotateVec(q, v) {
  const qv = [q.x, q.y, q.z];
  const t = cross(qv, v).map((c) => 2 * c);
  const c2 = cross(qv, t);
  return [v[0] + q.w * t[0] + c2[0], v[1] + q.w * t[1] + c2[1], v[2] + q.w * t[2] + c2[2]];
}
export function fromAxisAngle(axis, angle) {
  const a = unit(axis), s = Math.sin(angle / 2);
  return { x: a[0] * s, y: a[1] * s, z: a[2] * s, w: Math.cos(angle / 2) };
}
export function quatAngle(a, b) {
  const d = mulQuat(conj(normalizeQuat(a)), normalizeQuat(b));
  return 2 * Math.atan2(Math.hypot(d.x, d.y, d.z), Math.abs(d.w));
}
export function shortestArc(a, b) {
  const d = dot(a, b);
  if (d < -1 + 1e-12) {
    let axis = cross(a, [1, 0, 0]);
    if (norm(axis) < 1e-6) axis = cross(a, [0, 1, 0]);
    return fromAxisAngle(axis, Math.PI);
  }
  const c = cross(a, b);
  return normalizeQuat({ x: c[0], y: c[1], z: c[2], w: 1 + d });
}

/* ───────────────────────────── die shapes ───────────────────────────── */

export function createShape(faceNormals) {
  const normals = faceNormals.map(unit);
  if (normals.length < 2) throw new RangeError('need >= 2 faces');
  let minSep = Infinity;
  for (let i = 0; i < normals.length; i++)
    for (let j = i + 1; j < normals.length; j++)
      minSep = Math.min(minSep, Math.atan2(norm(cross(normals[i], normals[j])), dot(normals[i], normals[j])));
  if (minSep < 1e-6) throw new RangeError('duplicate face normals');
  return Object.freeze({ normals, count: normals.length, minSeparation: minSep });
}
export const CUBE = createShape([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]);
export const D6_FACE_VALUES = Object.freeze([3, 4, 1, 6, 2, 5]);

/* ───────────────────────── 1. dominant-face detection ───────────────────────── */

export function detectTopFace(q, normals, { up = [0, 1, 0], tieEps = 1e-9, hint = -1 } = {}) {
  const qn = normalizeQuat(q);
  const u = rotateVec(conj(qn), unit(up));
  let best = -Infinity;
  const d = new Array(normals.length);
  for (let i = 0; i < normals.length; i++) { d[i] = dot(normals[i], u); if (d[i] > best) best = d[i]; }
  const candidates = [];
  let second = -Infinity;
  for (let i = 0; i < d.length; i++) {
    if (d[i] >= best - tieEps) candidates.push(i);
    else if (d[i] > second) second = d[i];
  }
  const index = candidates.includes(hint) ? hint : candidates[0];
  const n = normals[index];
  return {
    index,
    dot: d[index],
    margin: candidates.length > 1 ? 0 : best - second,
    ambiguous: candidates.length > 1,
    candidates,
    tiltRad: Math.atan2(norm(cross(n, u)), dot(n, u)),
  };
}

/* ───────────────────────── 4. residual micro-jitter ───────────────────────── */

export function applyJitter(q, { rng = Math.random, maxDeg = 1.5, up = [0, 1, 0], tiltShare = 0.2 } = {}) {
  const cap = Math.min(maxDeg, 1.99) * DEG;
  const U = unit(up);
  const yaw = (rng() * 2 - 1) * cap * (1 - tiltShare);
  const ref = Math.abs(U[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(cross(U, ref)), e2 = cross(U, e1);
  const phi = rng() * 2 * Math.PI;
  const tiltAxis = [e1[0] * Math.cos(phi) + e2[0] * Math.sin(phi), e1[1] * Math.cos(phi) + e2[1] * Math.sin(phi), e1[2] * Math.cos(phi) + e2[2] * Math.sin(phi)];
  const tilt = rng() * cap * tiltShare;
  const j = mulQuat(fromAxisAngle(tiltAxis, tilt), fromAxisAngle(U, yaw));
  return normalizeQuat(mulQuat(j, normalizeQuat(q)));
}

/* ─────────────────────── 3. rules + minimal-change repair ─────────────────────── */

export const Rules = {
  any: () => ({ name: 'any', validate: () => true }),
  custom: (name, validate) => ({ name, validate }),
  sum: (S) => ({ name: `sum=${S}`, validate: (v) => v.reduce((a, b) => a + b, 0) === S }),
  allEqual: () => ({ name: 'allEqual', validate: (v) => v.every((x) => x === v[0]) }),
  allDistinct: () => ({ name: 'allDistinct', validate: (v) => new Set(v).size === v.length }),
  multiset: (target) => {
    const key = (a) => [...a].sort((x, y) => x - y).join(',');
    const k = key(target);
    return { name: `multiset(${k})`, validate: (v) => v.length === target.length && key(v) === k };
  },
};

export function resolveValues(natural, targets, valueSets, rules, maxEvaluations = 5_000_000) {
  const base = natural.map((v, i) => (targets[i] == null ? v : targets[i]));
  const free = natural.map((_, i) => i).filter((i) => targets[i] == null);
  let evals = 0;
  if (rules.validate(base)) return { ok: true, values: base, repaired: [] };

  const cand = free.map((i) => [...new Set(valueSets[i])].filter((v) => v !== base[i]));
  const work = base.slice();
  let budgetExceeded = false;

  const assign = (subset, pos, out) => {
    if (pos === subset.length) {
      if (++evals > maxEvaluations) { budgetExceeded = true; return false; }
      if (!rules.validate(work)) return false;
      out.found = subset.map((f) => free[f]);
      return true;
    }
    const f = subset[pos], i = free[f], orig = work[i];
    for (const v of cand[f]) {
      work[i] = v;
      if (assign(subset, pos + 1, out)) return true;
      if (budgetExceeded) break;
    }
    work[i] = orig;
    return false;
  };
  const choose = (k, start, subset, out) => {
    if (subset.length === k) return assign(subset, 0, out);
    for (let f = start; f < free.length; f++) {
      subset.push(f);
      if (choose(k, f + 1, subset, out)) return true;
      subset.pop();
      if (budgetExceeded) return false;
    }
    return false;
  };

  for (let k = 1; k <= free.length; k++) {
    const out = {};
    if (choose(k, 0, [], out) && out.found) return { ok: true, values: work.slice(), repaired: out.found };
    work.splice(0, work.length, ...base);
    if (budgetExceeded) return { ok: false, reason: 'search_budget_exceeded' };
  }
  return { ok: false, reason: 'rules_unsatisfiable' };
}

/* ─────────────────── 2. plan (pure) — no side effects, all checks here ─────────────────── */

export function remapFaceValues(faceValues, topIndex, want) {
  if (faceValues[topIndex] === want) return { faceValues: faceValues.slice(), swap: null };
  const j = faceValues.indexOf(want);
  if (j < 0) throw new RangeError(`value ${want} not present on die`);
  const out = faceValues.slice();
  out[topIndex] = want;
  out[j] = faceValues[topIndex];
  return { faceValues: out, swap: [topIndex, j] };
}

export function planFreeze(bodies, cfg = {}) {
  const { shape = CUBE, rules = Rules.any(), maxSnapDeg = 10, jitterDeg = 1.5, rng = Math.random, up = [0, 1, 0], tieEps = 1e-9 } = cfg;

  const dets = [];
  for (const b of bodies) {
    if (!Array.isArray(b.faceValues) || b.faceValues.length !== shape.count) throw new RangeError(`body ${b.id}: faceValues length`);
    const det = detectTopFace(b.quat, shape.normals, { up, tieEps, hint: b.hintFace ?? -1 });
    if (det.tiltRad > maxSnapDeg * DEG) return { ok: false, reason: 'not_settled', bodyId: b.id, tiltDeg: det.tiltRad / DEG };
    dets.push(det);
  }
  for (const b of bodies)
    if (b.target != null && !b.faceValues.includes(b.target)) return { ok: false, reason: 'target_not_on_die', bodyId: b.id };

  const natural = bodies.map((b, i) => b.faceValues[dets[i].index]);
  const res = resolveValues(natural, bodies.map((b) => b.target ?? null), bodies.map((b) => b.faceValues), rules);
  if (!res.ok) return res;

  const entries = bodies.map((b, i) => {
    const det = dets[i];
    const want = res.values[i];
    const { faceValues, swap } = remapFaceValues(b.faceValues, det.index, want);
    const qn = normalizeQuat(b.quat);
    const worldN = rotateVec(qn, shape.normals[det.index]);
    const snapped = normalizeQuat(mulQuat(shortestArc(worldN, unit(up)), qn));
    const quat = applyJitter(snapped, { rng, maxDeg: jitterDeg, up });
    return { id: b.id, quat, faceValues, swap, topIndex: det.index, value: want, snapDeg: det.tiltRad / DEG, ambiguous: det.ambiguous };
  });

  entries.forEach((e, i) => {
    const d = detectTopFace(e.quat, shape.normals, { up, tieEps });
    if (d.ambiguous || d.index !== e.topIndex || e.faceValues[d.index] !== e.value || (bodies[i].target != null && e.value !== bodies[i].target))
      throw new Error(`self-check failed for body ${e.id}`);
  });
  if (!rules.validate(entries.map((e) => e.value))) throw new Error('self-check failed: rules');

  return { ok: true, shape, up, entries, values: res.values, repaired: res.repaired.map((k) => bodies[k].id) };
}

/* ─────────────────── 5. atomic commit (single synchronous task) ─────────────────── */

const committed = new WeakSet();
let busy = false;
const mustBeSync = (r, what) => {
  if (r && typeof r.then === 'function') throw new TypeError(`adapter.${what} returned a Promise: async work would open a visible-frame window`);
  return r;
};

export function commitPlan(plan, adapter) {
  if (!plan?.ok) throw new Error('cannot commit a failed plan');
  if (committed.has(plan)) throw new Error('plan already committed');
  const saved = [];
  try {
    for (const e of plan.entries) saved.push([e.id, mustBeSync(adapter.capture(e.id), 'capture')]);
    for (const e of plan.entries) {
      mustBeSync(adapter.freezeBody(e.id), 'freezeBody');
      mustBeSync(adapter.setPose(e.id, e.quat), 'setPose');
      mustBeSync(adapter.setFaceValues(e.id, e.faceValues, e.swap), 'setFaceValues');
    }
    const shown = [];
    for (const e of plan.entries) {
      const rb = mustBeSync(adapter.readBack(e.id), 'readBack');
      const d = detectTopFace(rb.quat, plan.shape.normals, { up: plan.up });
      const v = rb.faceValues[d.index];
      if (d.ambiguous || v !== e.value) throw new Error(`read-back mismatch on body ${e.id}: shows ${v}, expected ${e.value}`);
      shown.push(v);
    }
    if (shown.length !== plan.values.length || shown.some((v, i) => v !== plan.values[i])) throw new Error('read-back set mismatch');
  } catch (err) {
    for (let i = saved.length - 1; i >= 0; i--) { try { adapter.restore(saved[i][0], saved[i][1]); } catch { /* best effort */ } }
    throw err;
  }
  committed.add(plan);
}

export function settleDice(bodies, cfg, adapter) {
  if (busy) return { ok: false, reason: 'reentrant' };
  busy = true;
  try {
    const plan = planFreeze(bodies, cfg);
    if (!plan.ok) return plan;
    commitPlan(plan, adapter);
    return plan;
  } finally { busy = false; }
}