const rank = { external: 0, core: 1, aggregation: 2, access: 3 }
const nodeRank = (n) =>
  n.node_type === 'network' || n.asset_kind === 'cloud'
    ? 0
    : n.layer === 'external'
      ? 4
      : (rank[n.layer] ?? 3)
export function topologyForest(nodes, links, rootId) {
  const ids = new Set(nodes.map((n) => String(n.id))),
    adj = new Map([...ids].map((id) => [id, []]))
  for (const l of links) {
    const a = String(l.source_node_id),
      b = String(l.target_node_id)
    if (l.lifecycle === 'history' || a === b || !ids.has(a) || !ids.has(b)) continue
    adj.get(a).push({ id: b, link: String(l.id) })
    adj.get(b).push({ id: a, link: String(l.id) })
  }
  const ordered = [...nodes].sort(
    (a, b) =>
      Number(String(b.id) === String(rootId)) - Number(String(a.id) === String(rootId)) ||
      nodeRank(a) - nodeRank(b) ||
      adj.get(String(b.id)).length - adj.get(String(a.id)).length ||
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
  )
  const parent = {},
    parent_link = {},
    depth = {},
    roots = [],
    order = []
  for (const node of ordered) {
    const root = String(node.id)
    if (root in parent) continue
    roots.push(root)
    parent[root] = null
    depth[root] = 0
    const queue = [root]
    for (let i = 0; i < queue.length; i++) {
      const a = queue[i]
      order.push(a)
      for (const b of adj
        .get(a)
        .sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true }))) {
        if (b.id in parent) continue
        parent[b.id] = a
        parent_link[b.id] = b.link
        depth[b.id] = depth[a] + 1
        queue.push(b.id)
      }
    }
  }
  return { parent, parent_link, depth, roots, order }
}

export function hierarchicalLayout(nodes, links, rootId) {
  nodes = nodes.map((n) => ({
    ...n,
    width: Math.max(220, Number(n.width) || 220),
    height: Math.max(136, Number(n.height) || 136),
  }))
  const tree = topologyForest(nodes, links, rootId),
    byId = new Map(nodes.map((n) => [String(n.id), n]))
  const children = new Map(nodes.map((n) => [String(n.id), []])),
    span = new Map(),
    positions = new Map()
  for (const [id, parent] of Object.entries(tree.parent)) if (parent) children.get(parent).push(id)
  for (const id of [...tree.order].reverse())
    span.set(
      id,
      Math.max(
        Number(byId.get(id).width) || 220,
        children.get(id).reduce((sum, c) => sum + span.get(c) + 44, -44),
      ),
    )
  let left = 70
  for (const root of tree.roots) {
    const base =
      root === String(rootId)
        ? 0
        : tree.roots.length > 1
          ? Math.max(0, (rank[byId.get(root).layer] ?? 3) - 1) * 210
          : 0
    const queue = [{ id: root, x: left }]
    for (let i = 0; i < queue.length; i++) {
      const { id, x } = queue[i],
        n = byId.get(id)
      positions.set(id, {
        x: x + (span.get(id) - Number(n.width)) / 2,
        y: 70 + base + tree.depth[id] * 220,
      })
      let cursor = x
      for (const c of children.get(id)) {
        queue.push({ id: c, x: cursor })
        cursor += span.get(c) + 44
      }
    }
    left += span.get(root) + 100
  }
  const occupied = nodes
    .filter((n) => n.position_locked)
    .map((n) => ({
      ...n,
      x: Number(n.x),
      y: Number(n.y),
      width: Number(n.width),
      height: Number(n.height),
    }))
  return nodes.map((n) => {
    if (n.position_locked) return { ...n }
    let { x, y } = positions.get(String(n.id))
    const width = Number(n.width),
      height = Number(n.height)
    while (
      occupied.some(
        (p) =>
          x < p.x + p.width + 24 &&
          x + width + 24 > p.x &&
          y < p.y + p.height + 24 &&
          y + height + 24 > p.y,
      )
    )
      x += width + 44
    occupied.push({ x, y, width, height })
    return { ...n, x, y }
  })
}
