import { promises as fsp } from 'fs'
import { join } from 'path'
import { register, cwd, PackageJson } from 'yakumo'
import { compile, load } from 'tsconfig-utils'
import * as atsc from 'atsc'
import * as dtsc from 'dtsc'

interface Node {
  bundle: boolean
  path: string
  meta: PackageJson
  prev: string[]
  next: Set<string>
}

declare module 'yakumo' {
  interface Arguments {
    clean: boolean
  }
}

register('tsc', async (project) => {
  const { targets, argv } = project

  // build clean
  if (argv.clean) {
    for (const path in targets) {
      const fullpath = join(cwd, path)
      try {
        const { compilerOptions: { outDir = 'lib' }} = await load(fullpath)
        const fullOutDir = join(cwd, path, outDir)
        await Promise.allSettled([
          fsp.rm(fullOutDir, { recursive: true }),
          fsp.rm(join(fullpath, 'tsconfig.tsbuildinfo')),
          fsp.rm(join(fullpath, 'tsconfig.temp.json')),
        ])
      } catch {}
    }
    return
  }

  // Step 1: initialize nodes
  const nodes: Record<string, Node> = {}
  for (const path in targets) {
    const meta = targets[path]
    if (!meta.main) continue
    const fullpath = join(cwd, path)
    try {
      const config = await load(fullpath)
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
    const tasks = buildTargets.map(node => atsc.build(join(cwd, node.path)))
    await Promise.all([
      prepareBuild(buildTargets),
      bundleNodes(bundleTargets),
    ])
    if (buildTargets.length) {
      const code = await compile(['-b', 'tsconfig.temp.json'])
      if (code) process.exit(code)
    }
    await Promise.all(tasks)
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
    await dtsc.build(join(cwd, node.path))
  }
}
