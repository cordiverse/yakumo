import { promises as fsp } from 'fs'
import { join } from 'path'
import { Context, cwd, PackageJson } from 'yakumo'
import { compile, load } from 'tsconfig-utils'
import * as atsc from 'atsc'
import * as dtsc from 'dtsc'

declare module 'yakumo' {
  interface PackageConfig {
    tsc?: {
      ignore?: string[]
    }
  }
}

interface Node {
  bundle: boolean
  path: string
  meta: PackageJson
  prev: string[]
  next: Set<string>
}

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

export function apply(ctx: Context) {
  ctx.register('tsc', async () => {
    const { targets, argv } = ctx.yakumo

    // build clean
    if (argv.clean) {
      const tasks = Object.keys(targets).map(async (path) => {
        const fullpath = join(cwd, path)
        const tsconfig = await load(fullpath)
        await Promise.all([
          fsp.rm(join(cwd, path, tsconfig?.compilerOptions?.outDir || 'lib'), { recursive: true }),
          fsp.rm(join(fullpath, 'tsconfig.tsbuildinfo')),
        ])
      })
      tasks.push(fsp.rm(join(cwd, 'tsconfig.temp.json')))
      await Promise.allSettled(tasks)
      return
    }

    // Step 1: initialize nodes
    const nodes: Record<string, Node> = {}
    for (const path in targets) {
      const meta = targets[path]
      if (!meta.main && !meta.exports) continue
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
        if (!nodes[dep] || meta.yakumo?.tsc?.ignore?.includes(dep)) continue
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
}
