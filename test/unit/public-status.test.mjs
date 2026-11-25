import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createPublicStatusPage } from '../../src/lib/http/public-status.mjs'

test('the public status page displays projected numbers without identities or billing', (context) => {
  const db = new DatabaseSync(':memory:')
  context.after(() => db.close())
  db.exec(
    'CREATE TABLE usage_logs (vm_id TEXT, vm_owner_user_id TEXT, created_at TEXT, model TEXT, status INT, error_code TEXT, duration_ms INT)',
  )
  const now = Date.now()
  const stamp = (hours) => new Date(now + hours * 3600_000).toISOString()
  const insert = db.prepare('INSERT INTO usage_logs VALUES (?, ?, ?, ?, ?, NULL, ?)')
  insert.run('private-slot', null, stamp(0), 'claude-haiku-5-5', 200, 2000)
  insert.run('private-slot', null, stamp(-3), 'claude-haiku-5-5', 500, 1000)
  insert.run('private-slot', 'tenant-identity', stamp(0), 'gpt-100', 200, 2000)
  insert.run('private-slot', null, stamp(0), 'claude-<private-script>', 200, 2000)
  const slots = [
    {
      id: 'private-slot',
      name: 'private-name',
      email: 'private@example.com',
      total_cost: 123456,
      has_token: true,
      availability: { accept: true, text: 'private-error' },
      utilization_5h: 0.25,
      utilization_7d: 0.5,
      reset_5h: stamp(2.5),
      reset_7d: stamp(-1),
      quota_policy: { limit_5h: 0.8 },
      seats_used: 1,
      seats_max: 4,
    },
  ]
  let reads = 0
  const serve = createPublicStatusPage({
    getSlots: () => {
      reads += 1
      return slots
    },
    getNodes: () => [
      { id: 'private-node', health: { host: { load1: 1.5, cpu_count: 2, mem_total: 100, mem_used: 40 } } },
    ],
    getDb: () => db,
  })
  const request = (method) => {
    const result = {}
    serve(
      { method },
      {
        writeHead(status, headers) {
          Object.assign(result, { status, headers })
        },
        end(body) {
          result.body = body
        },
      },
    )
    return result
  }
  const { status, body } = request('GET')
  assert.equal(status, 200)
  assert.match(body, /槽位 01/)
  assert.match(body, /25%/)
  assert.match(body, /按时间均摊应使用 40%/)
  assert.match(body, /1 \/ 4/)
  assert.match(body, /2 成功 \/ 0 失败/)
  assert.match(body, /claude-haiku-5-5/)
  assert.match(body, /节点 1/)
  assert.match(body, /1.5 \/ 2 核/)
  assert.doesNotMatch(body, /private|tenant-identity|gpt-100|123456|费用|价格/)
  assert.equal(request('HEAD').body, undefined)
  assert.equal(request('POST').status, 405)
  assert.equal(reads, 1)
})
