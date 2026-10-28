// Temporary benchmark for askar tag filter query plans. Not part of the suite.
// Run from the repo root:
//   LIB_ASKAR_PATH=<dir with libaries_askar.so> BENCH_N=50000 \
//     pnpm vitest run --project e2e packages/askar/src/__tests__/or-query-bench.e2e.test.ts
import fs from 'node:fs'
import { NativeAskar } from '@openwallet-foundation/askar-nodejs'
import { Agent } from '../../../core/src/agent/Agent'
import { DidDocumentRole } from '../../../core/src/modules/dids/domain/DidDocumentRole'
import { DidRecord } from '../../../core/src/modules/dids/repository/DidRecord'
import { DidRepository } from '../../../core/src/modules/dids/repository/DidRepository'
import { agentDependencies } from '../../../node/src'
import { askarPostgresStorageConfig } from '../../tests/helpers'
import { AskarModule } from '../AskarModule'

const N = Number.parseInt(process.env.BENCH_N ?? '50000', 10)
const WARMUP = 6
const ITER = Number.parseInt(process.env.BENCH_ITER ?? '30', 10)

const agent = new Agent({
  config: { autoUpdateStorageOnStartup: false },
  dependencies: agentDependencies,
  modules: {
    askar: new AskarModule({
      askar: NativeAskar,
      store: { id: `OrBench${N}`, key: 'KeyOrBench', database: askarPostgresStorageConfig },
    }),
  },
})

const didOf = (i: number) => `did:bench:${i}`
const altOf = (i: number) => `did:benchalt:${i}`
const fpOf = (i: number) => `z6MkBench${i}`
const roleOf = (i: number) => (i % 10 === 0 ? DidDocumentRole.Created : DidDocumentRole.Received)
const record = (i: number) =>
  new DidRecord({
    did: didOf(i),
    role: roleOf(i),
    tags: { alternativeDids: [altOf(i)], recipientKeyFingerprints: [fpOf(i)] },
  })

async function bench(name: string, fn: () => Promise<unknown>, iter = ITER) {
  for (let i = 0; i < WARMUP; i++) await fn()
  const times: number[] = []
  for (let i = 0; i < iter; i++) {
    const t = performance.now()
    await fn()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  const mean = times.reduce((a, b) => a + b, 0) / times.length
  const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]
  return { name, mean, median: p(0.5), p95: p(0.95), max: times[times.length - 1], iter }
}

describe('askar $or query benchmark', () => {
  beforeAll(async () => {
    await agent.initialize()
  }, 600_000)

  afterAll(async () => {
    await agent.shutdown()
  })

  test('seed and measure', async () => {
    const ctx = agent.context
    const repo = ctx.dependencyManager.resolve(DidRepository)
    const sentinel = `did:bench:seeded-${N}`
    if ((await repo.findByQuery(ctx, { did: sentinel })).length === 0) {
      const _t = performance.now()
      for (let start = 0; start < N; start += 50) {
        await Promise.all(Array.from({ length: Math.min(50, N - start) }, (_, k) => repo.save(ctx, record(start + k))))
      }
      await repo.save(ctx, new DidRecord({ did: sentinel, role: DidDocumentRole.Created }))
    }

    const received = N - 7 // role received
    const created = N - 10 // role created
    const target = (await repo.findByQuery(ctx, { did: didOf(received) }))[0]
    expect(target).toBeDefined()
    const key = { fingerprint: fpOf(created) } as Parameters<DidRepository['findCreatedDidByRecipientKey']>[1]

    const results = [
      await bench('getById (no tag filter)', () => repo.getById(ctx, target.id)),
      await bench('findByQuery {did} (one tag)', () => repo.findByQuery(ctx, { did: didOf(received) })),
      await bench('findAllByDid ($or alt|did)', () => repo.findAllByDid(ctx, didOf(received))),
      await bench('findAllByDid via alt ($or)', () => repo.findAllByDid(ctx, altOf(received))),
      await bench('findReceivedDid ($or + role)', () => repo.findReceivedDid(ctx, didOf(received))),
      await bench('findCreatedDid ($or + role)', () => repo.findCreatedDid(ctx, didOf(created))),
      await bench('findCreatedDidByRecipientKey (fp AND role)', () => repo.findCreatedDidByRecipientKey(ctx, key)),
      await bench('getCreatedDids {method, did} (role AND method AND $or)', () =>
        repo.getCreatedDids(ctx, { method: 'bench', did: didOf(created) })
      ),
      await bench('findByQuery {role, method: none} (low-sel AND no match)', () =>
        repo.findByQuery(ctx, { role: DidDocumentRole.Created, method: 'nomatch' })
      ),
      await bench('findByQuery {role: created} (10% of records)', () => repo.findByQuery(ctx, { role: DidDocumentRole.Created }), 5),
    ]
    const fmt = (n: number) => n.toFixed(2).padStart(9)
    const lines = [
      `LIB_ASKAR_PATH=${process.env.LIB_ASKAR_PATH ?? '(bundled)'}  N=${N}  iterations=${ITER}`,
      `${'operation'.padEnd(58)} ${'mean ms'.padStart(9)} ${'median'.padStart(9)} ${'p95'.padStart(9)} ${'max'.padStart(9)}`,
      ...results.map((r) => `${r.name.padEnd(58)} ${fmt(r.mean)} ${fmt(r.median)} ${fmt(r.p95)} ${fmt(r.max)}`),
      '',
    ]
    const out = process.env.BENCH_OUT
    if (out) fs.appendFileSync(out, `${lines.join('\n')}\n`)
    else 
  }, 3_600_000)
})
