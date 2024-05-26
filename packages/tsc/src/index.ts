import * as fs from 'node:fs/promises'
import { join } from 'path'
import { Context, cwd, PackageJson } from 'yakumo'
import { compile, load, TsConfig } from 'tsconfig-utils'
import * as atsc from 'atsc'
import * as dtsc from 'dtsc'
import { extname } from 'node:path'

declare module 'yakumo' {
  interface PackageConfig {
    tsc?: {
      ignore?: string[]
    }
  }
}

interface Node {
  bundle: boolean
  config: TsConfig
  path: string
  meta: PackageJson
  prev: string[]
  next: Set<string>
}

async function prepareBuild(nodes: Node[]) {
  if (!nodes.length) return
  await fs.writeFile(cwd + '/tsconfig.temp.json', JSON.stringify({
    files: [],
    references: nodes.map(node => ({ path: '.' + node.path })),
  }, null, 2))
}

function getFiles(meta: PackageJson, outDir: string) {
  function addExport(pattern?: string) {
    if (!pattern) return
    if (pattern.startsWith('./')) pattern = pattern.slice(2)
    if (!pattern.startsWith(outDir + '/')) return
    const ext = extname(pattern)
    pattern = pattern.slice(outDir.length + 1, -ext.length)
    if (pattern.endsWith('.d')) {
      pattern = pattern.slice(0, -2)
    }
    files.add(pattern)
  }

  // TODO: support null targets
  function addConditionalExport(pattern?: PackageJson.Exports) {
    if (!pattern) return
    if (typeof pattern === 'string') return addExport(pattern)
    if ('types' in pattern) return addConditionalExport(pattern.types)
    if ('typings' in pattern) return addConditionalExport(pattern.typings)
    for (const key in pattern) {
      addConditionalExport(pattern[key])
    }
  }

  const files = new Set<string>()
  addExport(meta.main)
  addExport(meta.module)
  addConditionalExport(meta.exports)
  return [...files]
}

async function bundleNodes(nodes: Node[]) {
  for (const node of nodes) {
    // TODO: support multiple entry points
    await dtsc.build(join(cwd, node.path))
    console.log('dtsc:', node.path + '/lib/index.d.ts')
  }
}

export const inject = ['yakumo']

export function apply(ctx: Context) {
  ctx.register('tsc', async () => {
    const { argv } = ctx.yakumo
    const paths = ctx.yakumo.locate(ctx.yakumo.argv._)

    // build clean
    if (argv.clean) {
      const tasks = paths.map(async (path) => {
        const fullpath = join(cwd, path)
        const tsconfig = await load(fullpath)
        await Promise.allSettled([
          fs.rm(join(fullpath, tsconfig?.compilerOptions?.outDir || 'lib'), { recursive: true }),
          fs.rm(join(fullpath, 'tsconfig.tsbuildinfo')),
        ])
      })
      tasks.push(fs.rm(join(cwd, 'tsconfig.temp.json')))
      await Promise.allSettled(tasks)
      return
    }

    // Step 1: initialize nodes
    const nodes: Record<string, Node> = {}
    for (const path of paths) {
      const meta = ctx.yakumo.workspaces[path]
      if (!meta.main && !meta.exports) continue
      const fullpath = join(cwd, path)
      try {
        const config = await load(fullpath)
        if (!config || config.compilerOptions?.noEmit) continue
        const files = getFiles(meta, config.compilerOptions?.outDir || 'lib')
        const bundle = !!config.compilerOptions?.outFile || files.length === 1 && !!meta.exports
        nodes[meta.name] = { config, bundle, path, meta, prev: [], next: new Set() }
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
      await Promise.all(tasks)
      if (buildTargets.length) {
        const code = await compile(['-b', 'tsconfig.temp.json', '--listEmittedFiles'])
        if (code) process.exit(code)
      }
    }
    await fs.rm(join(cwd, 'tsconfig.temp.json')).catch(() => {})
  }, {
    boolean: ['clean'],
  })
}
