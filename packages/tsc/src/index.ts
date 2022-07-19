import { promises as fsp } from 'fs'
import { join } from 'path'
import { register, cwd, PackageJson, spawnAsync } from 'yakumo'
import { build } from 'dtsc'
import json5 from 'json5'
import ts from 'typescript'

interface Node {
  bundle: boolean
  path: string
  meta: PackageJson
  prev: string[]
  next: Set<string>
}

interface Reference {
  path: string
}

interface TsConfig {
  files?: string[]
  references?: Reference[]
  compilerOptions?: ts.CompilerOptions
}

register('tsc', async (project) => {
  // Step 1: initialize nodes
  const { targets } = project
  const nodes: Record<string, Node> = {}
  for (const path in targets) {
    const meta = targets[path]
    if (!meta.main) continue
    const fullpath = join(cwd, path)
    try {
      const content = await fsp.readFile(fullpath + '/tsconfig.json', 'utf-8')
      const config: TsConfig = json5.parse(content)
      const bundle = !!config.compilerOptions?.outFile
      nodes[meta.name] = { bundle, path, meta, prev: [], next: new Set() }
    } catch {}
  }

  // Step 2: build dependency graph
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

  // Step 3: generate bundle workflow
  let bundle = false
  const layers: Node[][] = []
  while (Object.keys(nodes).length) {
    const layer: Node[] = []
    bundle = !bundle
    let flag = true
    while (flag) {
      flag = false
      for (const name of Object.keys(nodes)) {
        const node = nodes[name]
        if (node.next.size || node.bundle === bundle) continue
        flag = true
        layer.unshift(node)
        delete nodes[name]
        node.prev.forEach((prev) => {
          nodes[prev].next.delete(name)
        })
      }
    }
    if (layers.length && !layer.length) {
      console.log(nodes)
      throw new Error('circular dependency detected')
    }
    layers.unshift(layer)
  }

  // Step 4: generate dts files
  // make sure the number of layers is even
  if (bundle) layers.unshift([])
  for (let i = 0; i < layers.length; i += 2) {
    const bundleTargets = layers[i]
    const buildTargets = layers[i + 1]
    await Promise.all([
      prepareBuild(buildTargets),
      bundleNodes(bundleTargets),
    ])
    if (buildTargets.length) {
      const code = await spawnAsync(['tsc', '-b', 'tsconfig.temp.json'])
      if (code) process.exit(code)
    }
  }
})

async function prepareBuild(nodes: Node[]) {
  if (!nodes.length) return
  await fsp.writeFile(cwd + '/tsconfig.temp.json', JSON.stringify({
    files: [],
    references: nodes.map(node => ({ path: '.' + node.path })),
  }, null, 2))
}

async function bundleNodes(nodes: Node[]) {
  for (const node of nodes) {
    await build(join(cwd, node.path))
  }
}
