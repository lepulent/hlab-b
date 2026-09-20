// Constitution (lab H-37; tiers and the floor ported from Mycelium src/lib/governance.ts and
// src/lib/seal-readiness.ts). PURE.
//
// A RULE IS A ROW PLUS A CHECK. The constitution has been parsed since step 3 and evaluated never:
// every row in both apps names a check that ends in "(pending)", which means the constitution has been
// a document about itself. This module is the half that was missing — it runs the check and says what
// the answer costs.
//
// THREE STATUSES, AND "UNENFORCED" IS ONE OF THEM. A rule whose check has no implementation is not
// passing and is not violated: it is UNENFORCED, counted and named on every report. The tempting
// alternatives are both lies — treat it as a pass and the constitution grades itself on the questions
// it declined to ask; treat it as a violation and nothing can ever seal, so the first thing anyone does
// is switch the constitution off. What is not checked is said out loud instead.
//
// TIER AND STAGE ARE DIFFERENT QUESTIONS (see stage.mjs for the table):
//   tier  — who can clear this? advisory → an agent, governing → the owner, constitutional → an
//           amendment. Mycelium's override ceiling, unchanged.
//   stage — does an uncleared violation stop the seal now? Only the governing tier moves with the
//           stage; the constitutional tier is the floor everywhere.
//
// NO `binds_from`. It was a lab invention — Mycelium has no such field — and it put the stage on each
// rule, so thirty rules meant thirty places to edit and thirty chances for one to disagree with the
// app it governs. The stage is declared once, in harness.json. A `binds_from:` line left in a
// constitution is reported as stale rather than quietly ignored: ignoring it is how a rule goes on
// looking like it says something it no longer says.
//
// NOTHING HERE READS A FILE OR CALLS A MODEL. The caller passes the text and the evidence.

import { TIER_ORDER, tierBlocks, lawFor } from './stage.mjs';

export const TIERS = Object.keys(TIER_ORDER);

// Mycelium VETO_CEILING, in the lab's words: what authority clears a violation at each tier. The lab
// has no "human lead" distinct from the owner, so hard-veto's ceiling is the owner.
export const CLEARED_BY = {
  constitutional: 'amendment',
  governing: 'owner',
  advisory: 'agent',
};

// ---------------------------------------------------------------- the rows

const RULE_RE = /^###\s+(C-\d+)\s+(.*)$/;
const FIELD_RE = /^-\s+([a-z_]+):\s*(.*)$/;

/**
 * Parse `canon/constitution.md` into rows. A row is `### C-n <title>` followed by `- field: value`
 * lines. Fields read: tier, check, alternative. A `binds_from` line is collected as `stale` rather
 * than dropped silently.
 *
 * TIER DEFAULTS TO CONSTITUTIONAL, which is Mycelium's readPrincipleTier fail-safe: a rule whose tier
 * nobody wrote must not silently LOSE authority. The cost of that default is a rule that blocks until
 * someone states its tier, which is the right way round.
 */
export function parseConstitution(text) {
  const rules = [];
  const stale = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    const h = RULE_RE.exec(line);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), tier: null, check: null, alternative: null };
      rules.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = FIELD_RE.exec(line.trim());
    if (!f) continue;
    const [, key, raw] = f;
    const value = raw.trim();
    if (key === 'tier') cur.tier = value;
    else if (key === 'check') cur.check = value;
    else if (key === 'alternative') cur.alternative = value;
    else if (key === 'binds_from')
      stale.push(
        `${cur.id} still carries binds_from: ${value}; the stage is declared in harness.json`,
      );
  }
  for (const r of rules) {
    r.declaredTier = r.tier;
    // unknown or absent → constitutional (never a silent loss of authority)
    if (!TIERS.includes(r.tier)) r.tier = 'constitutional';
    // "(pending)" is the marker the templates ship beside a check nobody had written yet. It is
    // DOCUMENTATION OF A FACT, never the fact: whether a check runs is whether it is implemented, and
    // that question is answered by the registry below. Letting the prose decide would mean a word in a
    // markdown file could switch off a working check — the sentence-instead-of-a-check failure this
    // harness exists to refuse. So the marker is read, reported when it has gone stale, and obeyed
    // never.
    r.pendingMarker = /\(pending\)/.test(r.check ?? '');
    r.checkId = (r.check ?? '').replace(/\s*\(pending\)\s*$/, '').trim() || null;
    r.clearedBy = CLEARED_BY[r.tier];
    if (r.pendingMarker && r.checkId && CHECKS[r.checkId])
      stale.push(
        `${r.id} still marks ${r.checkId} as "(pending)"; it is implemented and was run anyway`,
      );
  }
  rules.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { rules, stale };
}

// ---------------------------------------------------------------- the checks
//
// A check is a pure function of evidence. `realDataOnly` marks a rule that only bites once the app's
// data is real — at a stage where data is disposable it is NOT APPLICABLE, which is a fourth answer
// and not a pass. That is the consumer of stage.disposableData.

export const CHECKS = {
  // Every required tag is present AND carries a resolved value. A tag whose value is a placeholder
  // like "<computed>" is not a tag: nothing can be billed, queried or audited by it. Declaring the
  // key and deferring the value is exactly the state "tagged from birth" exists to refuse.
  'policy/tags-present': {
    needs: 'manifest',
    realDataOnly: false,
    run: ({ manifest, requiredTags = [] } = {}) => {
      if (!manifest) return { ok: null, detail: 'no infra manifest to read' };
      const offenders = [];
      for (const r of manifest.resources ?? []) {
        const where = `${r.type ?? '?'} ${r.name ?? r.logicalId ?? '?'}`;
        for (const tag of requiredTags) {
          const v = r.tags?.[tag];
          if (v === undefined || v === null || String(v).trim() === '')
            offenders.push(`${where}: ${tag} missing`);
          else if (/^<.*>$/.test(String(v).trim()))
            offenders.push(`${where}: ${tag} is the placeholder ${v}`);
        }
      }
      return {
        ok: offenders.length === 0,
        offenders,
        detail: offenders.length
          ? `${offenders.length} tag(s) unresolved across ${manifest.resources?.length ?? 0} resource(s)`
          : `every required tag resolved on ${manifest.resources?.length ?? 0} resource(s)`,
      };
    },
  },
};

// ---------------------------------------------------------------- evaluation

export const STATUSES = ['pass', 'violated', 'unenforced', 'not-applicable'];

/**
 * Evaluate every rule against the stage and the evidence. Pure; deterministic; sorted by rule id.
 *
 * A verdict's `blocking` is the two-axis answer: a violation blocks iff its tier blocks at this stage
 * (stage.mjs tierBlocks). Nothing else blocks — not an unenforced rule, not a stale field, not a rule
 * that does not apply. Mycelium's law, kept: everything that is not the floor seals, and what was
 * cleared rather than resolved is recorded instead.
 */
export function evaluate({ text, rules, stage = 'sandbox', evidence = {} } = {}) {
  const parsed = rules ? { rules, stale: [] } : parseConstitution(text);
  const disposable = lawFor(stage).disposableData;
  const verdicts = parsed.rules.map((rule) => {
    const base = {
      id: rule.id,
      title: rule.title,
      tier: rule.tier,
      check: rule.checkId,
      clearedBy: rule.clearedBy,
    };
    const impl = rule.checkId ? CHECKS[rule.checkId] : null;
    if (!impl)
      return {
        ...base,
        status: 'unenforced',
        blocking: false,
        detail: rule.checkId ? `${rule.checkId} has no implementation` : 'the rule names no check',
      };
    if (impl.realDataOnly && disposable)
      return {
        ...base,
        status: 'not-applicable',
        blocking: false,
        detail: `data is disposable at ${stage}`,
      };
    const r = impl.run(evidence);
    if (r.ok === null) return { ...base, status: 'unenforced', blocking: false, detail: r.detail };
    return {
      ...base,
      status: r.ok ? 'pass' : 'violated',
      blocking: r.ok ? false : tierBlocks(rule.tier, stage),
      detail: r.detail,
      offenders: r.offenders ?? [],
    };
  });
  const violated = verdicts.filter((v) => v.status === 'violated');
  return {
    stage,
    verdicts,
    stale: parsed.stale,
    violated,
    blocking: violated.filter((v) => v.blocking),
    flagged: violated.filter((v) => !v.blocking),
    unenforced: verdicts.filter((v) => v.status === 'unenforced'),
    ok: !violated.some((v) => v.blocking),
  };
}

// ---------------------------------------------------------------- debt

/**
 * The debt a flagged violation mints. Mycelium's DEFERRED ledger in the lab's shape: a concern that
 * was carried rather than resolved, recorded with what it was, when, and who can clear it.
 *
 * A row is keyed by rule id, so a violation that survives ten plans is one row with the plan and
 * commit that FIRST recorded it — not ten rows saying the same thing more loudly.
 */
export function debtRows({ flagged = [], plan, commit, stage, at, prior = [] } = {}) {
  const byId = new Map(prior.map((d) => [d.rule, d]));
  for (const v of flagged) {
    const existing = byId.get(v.id);
    if (existing) {
      existing.detail = v.detail;
      existing.lastSeen = { plan, commit, at };
      continue;
    }
    byId.set(v.id, {
      rule: v.id,
      title: v.title,
      tier: v.tier,
      stage,
      detail: v.detail,
      clearedBy: v.clearedBy,
      recorded: { plan, commit, at },
      lastSeen: { plan, commit, at },
      accepted: null,
    });
  }
  return [...byId.values()].sort((a, b) => a.rule.localeCompare(b.rule, 'en', { numeric: true }));
}

/** Debt is cleared by the violation going away, not by anyone saying so. */
export function clearDebt({ debt = [], verdicts = [] } = {}) {
  const violated = new Set(verdicts.filter((v) => v.status === 'violated').map((v) => v.id));
  return debt.filter((d) => violated.has(d.rule));
}

/**
 * What refuses a stage raise. Moving up is refused while a debt row would BLOCK at the new stage and
 * has neither been cleared nor accepted by the authority its tier names. This is the one place debt
 * has teeth: it is free to carry a governing violation through sandbox and alpha, and it is not free
 * to arrive at beta still carrying it.
 */
export function stageRaiseRefusals({ from, to, debt = [] } = {}) {
  const refusals = [];
  for (const d of debt) {
    if (!tierBlocks(d.tier, to)) continue;
    if (tierBlocks(d.tier, from)) continue; // already blocking where it is; not a raise problem
    if (d.accepted?.by) continue;
    refusals.push(
      `${d.rule} (${d.tier}) is unresolved debt that blocks at ${to}: ${d.detail}. Clear it, or record acceptance by the ${d.clearedBy}.`,
    );
  }
  return refusals;
}

// ---------------------------------------------------------------- views

export function constitutionView(result) {
  const line = (v) =>
    `- ${v.id} ${v.tier} (${v.check ?? 'no check'}): ${v.status}${v.blocking ? ' — BLOCKS THE SEAL' : ''}${v.detail ? ` — ${v.detail}` : ''}`;
  return [
    `Constitution at stage ${result.stage}: ${result.blocking.length} blocking, ${result.flagged.length} flagged as debt, ${result.unenforced.length} unenforced of ${result.verdicts.length} rule(s).`,
    ...result.verdicts.map(line),
    ...result.stale.map((s) => `- stale: ${s}`),
  ].join('\n');
}
