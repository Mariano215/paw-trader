// src/trader/schema-gen-drift.test.ts
//
// server/src/trader-schema.gen.ts is a copy of src/trader/schema.ts, refreshed
// by scripts/deploy-dashboard.sh at deploy time so the server build never
// imports across the repo boundary. That copy is only as fresh as the last
// deploy, so a migration committed without a deploy leaves the server pinned
// to an older schema version. That happened with migration 6 (excluded_at):
// the bot wrote the column, the server's EXPECTED_TRADER_COLUMNS did not know
// about it, and /internal/trader-sync would have 500'd on the verdicts write
// while assertTraderSchema stayed green on the bot side.
//
// This test fails the moment the copy drifts, so the staleness is caught in CI
// rather than in a production sync.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = resolve(here, 'schema.ts')
const GENERATED = resolve(here, '../../server/src/trader-schema.gen.ts')

/** Number of header lines deploy-dashboard.sh prepends before the cat. */
const HEADER_LINES = 4

describe('trader-schema.gen.ts', () => {
  it('is byte-identical to src/trader/schema.ts below the generated header', () => {
    const source = readFileSync(SOURCE, 'utf8')
    const generated = readFileSync(GENERATED, 'utf8')
    const body = generated.split('\n').slice(HEADER_LINES).join('\n')

    expect(
      body,
      'server/src/trader-schema.gen.ts is stale. Regenerate it (npm run deploy:dashboard does this, ' +
        'or re-run the generation block in scripts/deploy-dashboard.sh) and commit the result.',
    ).toBe(source)
  })

  it('still carries the generated-file header', () => {
    const generated = readFileSync(GENERATED, 'utf8')
    expect(generated.startsWith('// GENERATED FILE -- do not edit.')).toBe(true)
  })
})
