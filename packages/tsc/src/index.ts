import { promises as fsp } from 'fs'
import { register, cwd, PackageJson, spawnAsync } from 'yakumo'

interface Node {
  path?: string
  meta?: PackageJson
  prev?: string[]
  next?: Set<string>
}

interface Reference {
  path: string
}

interface TsConfig {
  files?: string[]
  references?: Reference[]
}

register('tsc', async (project) => {
  const { targets } = project
  const nodes: Record<string, Node> = {}
  for (const path in targets) {
    const meta = targets[path]
    if (!meta.main) continue
    nodes[meta.name] = { path, meta, prev: [], next: new Set() }
  }

  for (const name in nodes) {
    const { meta } = nodes[name]
    const deps = {
      ...meta.dependencies,
      ...meta.devDependencies,
      ...meta.peerDependencies,
    }
    for (const dep in deps) {
      if (!nodes[dep]) continue
      nodes[name].prev.push(dep)
      nodes[dep].next.add(name)
    }
    delete nodes[name].meta
  }

  function check(name: string) {
    const node = nodes[name]
    if (node.next.size) return true
    delete nodes[name]
    config.references.unshift({ path: '.' + node.path })
    node.prev.forEach(dep => {
      nodes[dep].next.delete(name)
    })
  }

  let names: string[]
  const config: TsConfig = { files: [], references: [] }
  do {
    names = Object.keys(nodes)
  } while (names.length && !names.every(check))

  if (names.length) {
    console.log(nodes)
    throw new Error('circular dependency detected')
  }

  if (!config.references.length) return
  await fsp.writeFile(cwd + '/tsconfig.temp.json', JSON.stringify(config))

  const code = await spawnAsync(['tsc', '-b', 'tsconfig.temp.json'])
  if (code) process.exit(code)
})