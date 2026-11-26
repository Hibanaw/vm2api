import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { syncVmFile } from '../../src/lib/vm/vm-db-sync.mjs'
import { setVmWriteHook } from '../../src/lib/vm/vm-file.mjs'
import { renameVmId } from '../../src/lib/vm/vm-rename.mjs'

function seed(root, id, extra = {}) {
  const dir = path.join(root, 'vms', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'marker.txt'), id)
  const vm = { id, name: '槽', status: 'stopped', ...extra }
  fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm))
  return vm
}

test('renameVmId moves the record and slot directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-'))
  try {
    seed(root, 'slot-a')
    fs.writeFileSync(path.join(root, 'vms', 'active.json'), JSON.stringify({ active_vm: 'slot-a' }))
    const renamed = renameVmId(root, 'slot-a', 'slot-b')
    assert.equal(renamed.ok, true)
    assert.equal(renamed.id, 'slot-b')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-a.json')), false)
    assert.equal(fs.readFileSync(path.join(root, 'vms', 'slot-b', 'marker.txt'), 'utf8'), 'slot-a')
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'slot-b.json'), 'utf8'))
    assert.equal(saved.id, 'slot-b')
    assert.equal(saved.name, '槽')
    const active = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'active.json'), 'utf8'))
    assert.equal(active.active_vm, 'slot-b')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('renameVmId refuses a running, remote, or taken slot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-'))
  try {
    seed(root, 'slot-a', { status: 'running' })
    assert.equal(renameVmId(root, 'slot-a', 'slot-c').code, 'vm_running')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-a.json')), true)

    const stopped = {
      ...JSON.parse(fs.readFileSync(path.join(root, 'vms', 'slot-a.json'), 'utf8')),
      status: 'stopped',
    }
    fs.writeFileSync(path.join(root, 'vms', 'slot-a.json'), JSON.stringify(stopped))
    seed(root, 'slot-b')
    assert.equal(renameVmId(root, 'slot-a', 'slot-b').code, 'vm_id_taken')

    fs.writeFileSync(path.join(root, 'vms', 'slot-a.json'), JSON.stringify({ ...stopped, node_id: 'node-1' }))
    assert.equal(renameVmId(root, 'slot-a', 'slot-d').code, 'remote_vm')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-a.json')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('renameVmId updates live SQLite references for a stopped slot', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-sqlite-'))
  context.after(() => {
    setVmWriteHook(null)
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const db = openDatabase({ dbPath: path.join(root, 'kin.db') })
  const vms = new VmsRepo(db)
  const slot = seed(root, 'slot-a')
  vms.upsertFromVmJson(slot)
  setVmWriteHook(syncVmFile)
  db.prepare('INSERT INTO sticky_sessions (key, vm_id) VALUES (?, ?)').run('sess:rename', slot.id)

  assert.equal(renameVmId(root, slot.id, 'vm-00').ok, true)
  assert.equal(vms.get(slot.id), null)
  assert.equal(vms.get('vm-00').id, 'vm-00')
  assert.equal(db.prepare('SELECT vm_id FROM sticky_sessions WHERE key = ?').get('sess:rename').vm_id, 'vm-00')
})

test('renameVmId refuses an invalid id without writing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-'))
  try {
    seed(root, 'slot-a')
    assert.equal(renameVmId(root, 'slot-a', '../slot').code, 'invalid_id')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-a.json')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
