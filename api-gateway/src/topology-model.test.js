import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveNeighbor,
  physicalIdentity,
  deriveLinkState,
  layoutTopology,
  normalizePort,
  reconcileNeighborPorts,
} from './topology-model.js'

const devices = [
  { id: '1', name: 'core.example', host: '192.0.2.1' },
  { id: '2', name: 'edge.example', host: '192.0.2.2' },
]
const ports = [
  { id: '11', device_id: '1', if_name: 'TenGigabitEthernet1/0/1' },
  { id: '12', device_id: '2', if_name: '10GE1/0/2' },
]
test('address and normalized port names match, ambiguous short names require confirmation', () => {
  const n = resolveNeighbor(
    {
      device_id: '1',
      remote_mgmt_address: '192.0.2.2',
      remote_port_id: 'TenGigabitEthernet1/0/2',
      local_port_id: '10GE1/0/1',
    },
    devices,
    ports,
    [],
    null,
  )
  assert.equal(n.remote_device_id, '2')
  assert.equal(n.local_interface_id, '11')
  assert.equal(n.remote_interface_id, '12')
  const ambiguous = resolveNeighbor(
    { device_id: '1', remote_sys_name: 'edge' },
    [...devices, { id: '3', name: 'edge.other', host: '192.0.2.3' }],
    ports,
    [],
    null,
  )
  assert.equal(ambiguous.match_state, 'conflict')
  assert.equal(ambiguous.remote_device_id, null)
  const manual = resolveNeighbor({ device_id: '1', remote_sys_name: 'edge' }, devices, ports, [], {
    remote_device_id: '2',
    remote_interface_id: '11',
  })
  assert.equal(manual.remote_interface_id, null, 'a port owned by another device is not accepted')
})
test('short-name-only identity stays a candidate until manually confirmed', () => {
  const row = { device_id: '1', remote_sys_name: 'edge.other' }
  const weak = resolveNeighbor(row, devices, ports, [], null)
  assert.equal(weak.match_state, 'needs_confirmation')
  assert.equal(weak.remote_device_id, null)
  assert.equal(weak.candidates.length, 1)
  assert.equal(
    resolveNeighbor(row, devices, ports, [], { remote_device_id: '2' }).match_state,
    'matched',
  )
})
test('port abbreviations and unique aliases match; ambiguous aliases do not', () => {
  assert.equal(normalizePort('Gi1/0/2'), normalizePort('GigabitEthernet1/0/2'))
  assert.equal(normalizePort('Te1/0/2'), normalizePort('XGE1/0/2'))
  const row = { device_id: '1', remote_mgmt_address: '192.0.2.2', remote_port_id: 'uplink-to-core' }
  const aliases = [{ ...ports[1], if_alias: 'uplink-to-core' }]
  assert.equal(resolveNeighbor(row, devices, aliases, [], null).remote_interface_id, '12')
  assert.equal(
    resolveNeighbor(row, devices, [...aliases, { ...aliases[0], id: '13' }], [], null)
      .remote_interface_id,
    null,
  )
})
test('partial evidence fills only a uniquely anchored physical connection, preserving parallel ports', () => {
  const now = new Date().toISOString()
  const full = {
    device_id: '1',
    remote_device_id: '2',
    local_interface_id: '11',
    remote_interface_id: '12',
    last_seen_at: now,
  }
  const partial = { ...full, remote_interface_id: null, remote_port_id: '' }
  const result = reconcileNeighborPorts([full, partial], ports)
  assert.equal(physicalIdentity(result[0]), physicalIdentity(result[1]))
  const ambiguous = reconcileNeighborPorts(
    [full, { ...full, remote_interface_id: '13' }, partial],
    ports,
  )
  assert.equal(ambiguous[2].remote_interface_id, null)
  const separate = reconcileNeighborPorts([full, { ...partial, local_interface_id: '14' }], ports)
  assert.equal(separate[1].remote_interface_id, null)
  assert.equal(
    reconcileNeighborPorts([{ ...full, stale: true }, partial], ports)[1].remote_interface_id,
    null,
  )
})
test('LLDP, CDP and opposite-direction evidence share a physical identity but parallel ports do not', () => {
  const a = {
    device_id: '1',
    remote_device_id: '2',
    local_interface_id: '11',
    remote_interface_id: '12',
    protocol: 'lldp',
  }
  const b = {
    device_id: '2',
    remote_device_id: '1',
    local_interface_id: '12',
    remote_interface_id: '11',
    protocol: 'cdp',
  }
  assert.equal(physicalIdentity(a), physicalIdentity(b))
  assert.notEqual(physicalIdentity(a), physicalIdentity({ ...a, local_interface_id: '13' }))
})
test('stale neighbor evidence is not a physical link failure, fresh endpoint evidence controls status', () => {
  const now = Date.now(),
    current = new Date(now).toISOString()
  const link = { auto_discovered: true, source_interface_id: '11', target_interface_id: '12' }
  const p = [
    { id: '11', oper_status: '1', last_seen_at: current },
    { id: '12', oper_status: '1', last_seen_at: current },
  ]
  assert.equal(
    deriveLinkState(link, p, [{ stale: true, last_seen_at: current }], [], now).status,
    'stale',
  )
  assert.equal(
    deriveLinkState(link, p, [{ stale: false, last_seen_at: current }], [], now).status,
    'up',
  )
  assert.equal(
    deriveLinkState(link, [{ ...p[0], oper_status: '2' }, p[1]], [], [], now).status,
    'down',
  )
  assert.equal(
    deriveLinkState(link, [{ ...p[0], admin_status: '2' }, p[1]], [], [], now).status,
    'disabled',
  )
  assert.equal(deriveLinkState(link, [], [], [{ device_status: 'offline' }], now).status, 'down')
  assert.equal(
    deriveLinkState({ ...link, auto_discovered: false }, [], [], [], now).status,
    'unknown',
  )
})
test('automatic layout preserves locks and avoids overlapping existing positions', () => {
  const nodes = [
    { id: '1', x: 60, y: 60, width: 190, height: 76, layer: 'core', position_locked: true },
    { id: '2', x: 5, y: 5, width: 190, height: 76, layer: 'core' },
    { id: '3', x: 0, y: 0, width: 190, height: 76, layer: 'access' },
  ]
  const result = layoutTopology(nodes, [])
  assert.equal(result.find((n) => n.id === '1').x, 60)
  assert.notEqual(result.find((n) => n.id === '2').x, 60)
  assert.ok(result.find((n) => n.id === '3').y > result.find((n) => n.id === '2').y)
})
