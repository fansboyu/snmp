import test from 'node:test'
import assert from 'node:assert/strict'
import { topologyForest, hierarchicalLayout } from './topology-layout.js'
const nodes = Array.from({ length: 5 }, (_, i) => ({
  id: String(i + 1),
  width: 220,
  height: 136,
  x: 0,
  y: 0,
  layer: i ? 'access' : 'core',
}))
const links = [
  [1, 2],
  [1, 3],
  [2, 4],
  [3, 4],
  [1, 2],
].map(([a, b], i) => ({ id: String(i + 1), source_node_id: String(a), target_node_id: String(b) }))
test('rooted forest retains cycles, parallel evidence and disconnected devices without changing links', () => {
  const tree = topologyForest(nodes, links, '3')
  assert.equal(tree.parent['3'], null)
  assert.equal(tree.order.length, 5)
  assert.equal(tree.roots.length, 2)
  assert.equal(links.length, 5)
  for (const id of tree.order) {
    const seen = new Set()
    let p = id
    while (p) {
      assert.ok(!seen.has(p))
      seen.add(p)
      p = tree.parent[p]
    }
  }
})
test('subtree layout centers parents, preserves locks and does not overlap', () => {
  const result = hierarchicalLayout(nodes, links, '1'),
    a = result.find((n) => n.id === '1'),
    b = result.find((n) => n.id === '2'),
    c = result.find((n) => n.id === '3')
  assert.ok(a.y < b.y)
  assert.equal(a.x, (b.x + c.x) / 2)
  for (let i = 0; i < result.length; i++)
    for (let j = i + 1; j < result.length; j++) {
      const p = result[i],
        q = result[j]
      assert.ok(
        p.x + p.width <= q.x ||
          q.x + q.width <= p.x ||
          p.y + p.height <= q.y ||
          q.y + q.height <= p.y,
      )
    }
  const locked = hierarchicalLayout(
    nodes.map((n) => (n.id === '2' ? { ...n, x: 980, y: 850, position_locked: true } : n)),
    links,
    '1',
  ).find((n) => n.id === '2')
  assert.equal(locked.x, 980)
  assert.equal(locked.y, 850)
})
test('historical edges do not define current hierarchy', () => {
  const t = topologyForest(nodes, [{ ...links[0], lifecycle: 'history' }], '1')
  assert.equal(t.roots.length, 5)
})
test('unknown neighbors do not outrank a known core when selecting a root', () => {
  const tree = topologyForest(
    [
      { ...nodes[0], layer: 'core' },
      { ...nodes[1], layer: 'external', identity_key: 'unknown' },
    ],
    [links[0]],
  )
  assert.equal(tree.roots[0], '1')
})
