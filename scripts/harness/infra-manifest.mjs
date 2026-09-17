#!/usr/bin/env node
// Emits canon/generated/infra-manifest.json: the declared resources of sst.config.ts and, per deployed
// stage, the real AWS resources read from the SST state export, in the shape of Futurator-Admin's
// manifest/infra.json (type, name, arn, tags, verification_status).
// Inputs, all committed so the output is deterministic (generatedAt aside):
//   canon/generated/system-graph.json          declared SST resources (nodes with a logicalId)
//   sst.config.ts                               provider default tags
//   canon/generated/infra-state.<stage>.json    reduced state export, written by `--reduce <export> --stage <s>`
// Modes:
//   node infra-manifest.mjs                              regenerate the manifest
//   node infra-manifest.mjs --reduce <export> --stage s  write canon/generated/infra-state.<s>.json from an `sst state export`
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readJson, writeJson } from './common.mjs';

export const TYPE_OF = {
  table: 'dynamodb-table',
  lambda: 'lambda-function',
  site: 'static-site',
  bucket: 's3-bucket',
  cron: 'eventbridge-rule',
  email: 'ses-identity',
  topic: 'sns-topic',
  queue: 'sqs-queue',
  bus: 'eventbridge-bus',
  secret: 'secret',
  cloudfront: 'cloudfront-distribution',
  iamRole: 'iam-role',
  iamRolePolicy: 'iam-role-policy',
};

// defaultTags: { tags: { Key: 'value', Other: expr } } → { Key: 'value', Other: '<computed>' }
export function parseDefaultTags(source) {
  const m = /defaultTags\s*:\s*\{\s*tags\s*:\s*\{([\s\S]*?)\}\s*,?\s*\}/.exec(source);
  if (!m) return {};
  const tags = {};
  for (const line of m[1].split('\n')) {
    const p = /^\s*([A-Za-z_][\w:-]*|'[^']+'|"[^"]+")\s*:\s*(.+?),?\s*$/.exec(line);
    if (!p) continue;
    const key = p[1].replace(/^['"]|['"]$/g, '');
    const v = p[2].trim();
    const lit = /^(['"`])(.*)\1$/.exec(v);
    tags[key] = lit ? lit[2] : '<computed>';
  }
  return tags;
}

export function parseAppFacts(source) {
  const name = /name\s*:\s*['"]([^'"]+)['"]/.exec(source)?.[1] ?? null;
  const region = /region\s*:\s*['"]([^'"]+)['"]/.exec(source)?.[1] ?? null;
  return { name, region };
}

export function declaredRows(systemGraph, defaultTags) {
  const rows = [];
  for (const n of systemGraph?.nodes || []) {
    if (!n.logicalId || !TYPE_OF[n.kind]) continue;
    rows.push({
      type: TYPE_OF[n.kind],
      name: n.logicalId,
      logicalId: n.logicalId,
      arn: null,
      tags: { ...defaultTags },
      verification_status: 'declared',
      verification: {},
      source: 'sst.config.ts',
    });
  }
  return rows.sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name));
}

// aws:cloudfront/distribution:Distribution → cloudfront-distribution ; aws:s3/bucketV2:BucketV2 → s3-bucket
export function awsTypeOf(pulumiType) {
  const m = /^aws:([^/]+)\/[^:]+:([A-Za-z0-9]+)$/.exec(pulumiType);
  if (!m) return null;
  const name = m[2]
    .replace(/V\d+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
  return `${m[1]}-${name}`;
}

// Reduce an `sst state export` (Pulumi checkpoint) to the real AWS resources, each attributed to the
// top-level SST component it belongs to. Deterministic: sorted by urn, no timestamps.
export function reduceState(state, stage) {
  const all = state?.latest?.resources || state?.deployment?.resources || state?.resources || [];
  const byUrn = new Map(all.map((r) => [r.urn, r]));
  const nameOf = (urn) => urn.split('::').pop();
  const stackUrn = all.find((r) => r.type === 'pulumi:pulumi:Stack')?.urn;
  const componentOf = (r) => {
    let cur = r;
    while (cur && cur.parent && cur.parent !== stackUrn) cur = byUrn.get(cur.parent);
    return cur && cur !== r
      ? nameOf(cur.urn)
      : cur === r && r.parent === stackUrn
        ? nameOf(r.urn)
        : null;
  };
  const rows = [];
  for (const r of all) {
    if (!r.type.startsWith('aws:')) continue;
    const o = r.outputs || {};
    if (!o.arn && !o.id) continue;
    const taggable = 'tagsAll' in o || 'tags' in o;
    rows.push({
      urn: r.urn,
      pulumiType: r.type,
      type: awsTypeOf(r.type),
      name: o.name || o.bucket || o.id || nameOf(r.urn),
      arn: o.arn || null,
      component: componentOf(r),
      taggable,
      tags: taggable ? { ...(o.tagsAll || o.tags || {}) } : {},
    });
  }
  rows.sort((a, b) => a.urn.localeCompare(b.urn));
  return { stage, resources: rows };
}

// Join the declared rows with each stage's reduced state. A declared component is verified on a stage
// when at least one real resource is attributed to it; a real taggable resource mismatches when a
// literal declared default tag differs from what AWS holds.
export function joinDeployments(declared, reduced, defaultTags) {
  const deployments = {};
  for (const red of reduced) {
    const rows = red.resources.map((r) => {
      const mismatch = r.taggable
        ? Object.entries(defaultTags)
            .filter(([k, v]) => v !== '<computed>' && r.tags[k] !== v)
            .map(([k]) => k)
        : [];
      return {
        ...r,
        verification_status: mismatch.length ? 'mismatch' : 'verified',
        ...(mismatch.length ? { mismatch } : {}),
      };
    });
    deployments[red.stage] = { resources: rows };
    for (const d of declared) {
      const mine = rows.filter((r) => r.component === d.logicalId);
      d.verification[red.stage] = !mine.length
        ? 'missing'
        : mine.some((r) => r.verification_status === 'mismatch')
          ? 'mismatch'
          : 'verified';
      if (!d.arn) d.arn = mine.find((r) => r.arn)?.arn || null;
    }
  }
  for (const d of declared) {
    const v = Object.values(d.verification);
    d.verification_status = v.includes('mismatch')
      ? 'mismatch'
      : v.includes('verified')
        ? 'verified'
        : v.length
          ? 'missing'
          : 'declared';
  }
  return deployments;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv;
  const GEN = join(ROOT, 'canon', 'generated');
  const ri = argv.indexOf('--reduce');
  if (ri > 0) {
    const si = argv.indexOf('--stage');
    const stage = si > 0 ? argv[si + 1] : null;
    const state = readJson(argv[ri + 1]);
    if (!state || !stage) {
      console.error('usage: infra-manifest.mjs --reduce <state export> --stage <stage>');
      process.exit(2);
    }
    const red = reduceState(state, stage);
    writeJson(join(GEN, `infra-state.${stage}.json`), red);
    console.log(`infra-state.${stage}: ${red.resources.length} aws resource(s)`);
    process.exit(0);
  }
  const cfgPath = join(ROOT, 'sst.config.ts');
  const source = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const sys = readJson(join(GEN, 'system-graph.json'), { nodes: [] });
  const facts = parseAppFacts(source);
  const tags = parseDefaultTags(source);
  const declared = declaredRows(sys, tags);
  const reduced = (existsSync(GEN) ? readdirSync(GEN) : [])
    .filter((f) => /^infra-state\.[\w-]+\.json$/.test(f))
    .sort()
    .map((f) => readJson(join(GEN, f)))
    .filter(Boolean);
  const deployments = joinDeployments(declared, reduced, tags);
  const manifest = {
    generatedAt: new Date().toISOString(),
    app: facts.name,
    region: facts.region,
    source: reduced.length
      ? `declared+state(${reduced.map((r) => r.stage).join(',')})`
      : 'declared',
    defaultTags: tags,
    resources: declared,
    deployments,
  };
  writeJson(join(GEN, 'infra-manifest.json'), manifest);
  const live = Object.values(deployments).reduce((n, d) => n + d.resources.length, 0);
  console.log(
    `infra-manifest: ${declared.length} declared · ${live} live across ${reduced.length} stage(s) · ${Object.keys(tags).length} default tag(s)`,
  );
}
