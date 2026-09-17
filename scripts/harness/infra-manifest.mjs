#!/usr/bin/env node
// Emits canon/generated/infra-manifest.json: one row per infrastructure resource, in the shape of
// Futurator-Admin's manifest/infra.json (type, name, arn, tags, verification_status).
// Sources, in order of authority:
//   declared  — sst.config.ts resources (from the system graph's infra nodes) + the provider default tags
//   state     — `sst state export` JSON given with --state <file>; rows found there become "verified"
// Deterministic: same inputs, same bytes (generatedAt aside).
import { readFileSync, existsSync } from 'node:fs';
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

// app/region/stage facts from the config, by text
export function parseAppFacts(source) {
  const name = /name\s*:\s*['"]([^'"]+)['"]/.exec(source)?.[1] ?? null;
  const region = /region\s*:\s*['"]([^'"]+)['"]/.exec(source)?.[1] ?? null;
  return { name, region };
}

// resource-level `transform: { ...: { tags: {...} } }` is not parsed yet; rows carry the default tags.
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
      source: 'sst.config.ts',
    });
  }
  return rows.sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name));
}

// Pulumi/SST state export: { deployment: { resources: [{ urn, type, outputs: { arn, tags, tagsAll } }] } }
export function verifyFromState(rows, state) {
  const resources = state?.deployment?.resources || state?.resources || [];
  for (const r of rows) {
    const hit = resources.find(
      (x) =>
        x.urn &&
        x.urn.split('::').pop() === r.logicalId &&
        x.outputs &&
        (x.outputs.arn || x.outputs.id),
    );
    if (!hit) {
      r.verification_status = 'missing';
      continue;
    }
    r.arn = hit.outputs.arn || null;
    r.name = hit.outputs.name || hit.outputs.bucket || hit.outputs.id || r.name;
    const live = hit.outputs.tagsAll || hit.outputs.tags || {};
    const mismatch = Object.entries(r.tags)
      .filter(([k, v]) => v !== '<computed>' && live[k] !== v)
      .map(([k]) => k);
    r.tags = { ...r.tags, ...live };
    r.verification_status = mismatch.length ? 'mismatch' : 'verified';
    if (mismatch.length) r.mismatch = mismatch;
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfgPath = join(ROOT, 'sst.config.ts');
  const source = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const sys = readJson(join(ROOT, 'canon', 'generated', 'system-graph.json'), {
    nodes: [],
  });
  const facts = parseAppFacts(source);
  const tags = parseDefaultTags(source);
  let rows = declaredRows(sys, tags);
  const si = process.argv.indexOf('--state');
  let stateSource = null;
  if (si > 0 && process.argv[si + 1]) {
    const state = readJson(process.argv[si + 1]);
    if (!state) {
      console.error(`infra-manifest: cannot read state file ${process.argv[si + 1]}`);
      process.exit(2);
    }
    rows = verifyFromState(rows, state);
    stateSource = process.argv[si + 1];
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    app: facts.name,
    region: facts.region,
    account: process.env.HARNESS_AWS_ACCOUNT || null,
    source: stateSource ? 'declared+state' : 'declared',
    defaultTags: tags,
    resources: rows,
  };
  writeJson(join(ROOT, 'canon', 'generated', 'infra-manifest.json'), manifest);
  console.log(
    `infra-manifest: ${rows.length} resource(s) · ${Object.keys(tags).length} default tag(s) · ${manifest.source}`,
  );
}
