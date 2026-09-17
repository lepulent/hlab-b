// Policy tests over the infra manifest. Each test title cites the constitution principle it enforces,
// so the canon check can join it to the principle's check id (policy/<name>).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Resource = {
  type: string | null;
  name: string;
  tags: Record<string, string>;
  taggable?: boolean;
  verification_status: string;
};
type Manifest = {
  resources: Resource[];
  deployments: Record<string, { resources: Resource[] }>;
};
type Harness = { infra?: { required_tags?: string[] } };

const read = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const manifest = read<Manifest>('canon/generated/infra-manifest.json');
const harness = read<Harness>('harness.json');
const REQUIRED = harness.infra?.required_tags ?? [];
const STORES = new Set(['dynamodb-table', 's3-bucket']);
const CLASSIFICATIONS = new Set(['public', 'internal', 'confidential', 'personal']);

const declared = manifest.resources;
const live = Object.entries(manifest.deployments ?? {}).flatMap(([stage, d]) =>
  d.resources.map((r) => ({ ...r, name: `${stage}:${r.name}` })),
);
const taggable = [...declared, ...live].filter((r) => r.taggable !== false);

describe('infra policy', () => {
  it('C-3 policy/tags-present: every declared and live taggable resource carries every required tag', () => {
    const missing = taggable.flatMap((r) =>
      REQUIRED.filter((k) => !r.tags[k]).map((k) => `${r.type} ${r.name}: ${k}`),
    );
    expect(missing).toEqual([]);
  });

  it('C-2 policy/manifest-classification: every store carries a known DataClassification', () => {
    const bad = taggable
      .filter((r) => r.type && STORES.has(r.type))
      .filter((r) => !CLASSIFICATIONS.has(r.tags['DataClassification'] ?? ''))
      .map((r) => `${r.type} ${r.name}`);
    expect(bad).toEqual([]);
  });

  it('policy/manifest-no-mismatch: no live resource disagrees with its declaration', () => {
    const mismatched = [...declared, ...live].filter((r) => r.verification_status === 'mismatch');
    expect(mismatched.map((r) => r.name)).toEqual([]);
  });
});
