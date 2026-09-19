// Pure rules for departments (Mycelium departments.ts, FR-17, D-3): a department veto is data — which
// tools, on which targets, with which stated reason — enforced at the tool-call boundary by the veto hook.
// No I/O here beyond what the caller passes.
import { globToRegex } from './common.mjs';

// the first veto of any department that forbids this tool on this target, or null
export function matchVeto(departments, tool, target) {
  if (!tool || !target) return null;
  for (const d of departments?.departments || [])
    for (const v of d.vetoes || [])
      if (
        (v.tools || []).includes(tool) &&
        (v.targets || []).some((g) => globToRegex(g).test(String(target)))
      )
        return { department: d.name, id: v.id, reason: v.reason };
  return null;
}

// crossDeptConflict means two departments would want different answers; with fewer than two
// departments it cannot be true, so the declaration is dropped and the drop recorded (steps 3 and 5,
// hlab-a: declared with one department in canon)
export function deriveTriggers(triggers, departments) {
  const n = (departments?.departments || []).length;
  const kept = [];
  const dropped = [];
  for (const t of triggers || []) {
    if (t === 'crossDeptConflict' && n < 2)
      dropped.push({ trigger: t, why: `${n} department(s) in canon; a conflict needs two` });
    else kept.push(t);
  }
  return { kept, dropped };
}

// a veto held when, after the denial, the same session never reached the same target with any tool
export function vetoHeld(footprint) {
  const denied = (footprint || []).filter((f) => f.denied);
  const breaches = [];
  for (const d of denied) {
    const after = (footprint || []).filter(
      (f) => f.ts > d.ts && !f.denied && f.target === d.target,
    );
    if (after.length)
      breaches.push(
        `${d.target} reached by ${after.map((f) => f.tool).join(', ')} after ${d.denied}`,
      );
  }
  return { denied, breaches, ok: !breaches.length };
}
