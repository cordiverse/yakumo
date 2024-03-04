import { Context, DependencyType, PackageJson, spawnAsync } from '../index.js'
import kleur from 'kleur'
import { gt } from 'semver'
import { latest } from '../utils.js'
import pMap from 'p-map'
import ora from 'ora'

export interface Config {
  concurrency?: number
}

declare module '../index.js' {
  interface PackageJson {
    $dirty?: boolean
  }
}

export const inject = ['yakumo']

export function apply(ctx: Context, config: Config = {}) {
  ctx.register('upgrade', async () => {
    const paths = ctx.yakumo.locate(ctx.yakumo.argv._, { includeRoot: true })
    const { manager } = ctx.yakumo
    const { concurrency = 10 } = config || {}
    const deps: Record<string, Record<string, Partial<Record<DependencyType, string[]>>>> = {}
    for (const path of paths) {
      load(path, ctx.yakumo.workspaces[path])
    }

    const output: string[] = []
    const requests = Object.keys(deps)
    const names = paths.map(path => ctx.yakumo.workspaces[path].name)
    const spinner = ora(`progress: 0/${requests.length}`).start()
    let progress = 0
    function updateProgress() {
      progress++
      spinner.text = `progress: ${progress}/${requests.length}`
    }

    await pMap(requests, async (request) => {
      const [dep, oldRange] = request.split(':')
      if (names.includes(dep)) return updateProgress()
      const oldVersion = oldRange.slice(1)
      const [newVersion, lastestVersion] = await Promise.all([
        latest(dep, { version: oldRange }),
        latest(dep, { version: ctx.yakumo.argv.next ? '' : 'latest' }),
      ])
      updateProgress()
      try {
        if (!gt(newVersion, oldVersion)) return
      } catch (error) {
        output.push(`- ${kleur.red(dep)}: skipped`)
        return
      }
      const newRange = oldRange[0] + newVersion
      output.push(`- ${kleur.yellow(dep)}: ${kleur.cyan(oldVersion)} -> ${kleur.green(newVersion)}${newVersion === lastestVersion ? '' : ` (latest: ${lastestVersion})`}`)
      for (const name in deps[request]) {
        Object.defineProperty(ctx.yakumo.workspaces[name], '$dirty', { value: true })
        for (const type in deps[request][name]) {
          for (const key of deps[request][name][type]) {
            ctx.yakumo.workspaces[name][type][key] = ctx.yakumo.workspaces[name][type][key].slice(0, -oldRange.length) + newRange
          }
        }
      }
    }, { concurrency })
    spinner.succeed()

    for (const path of paths) {
      if (!ctx.yakumo.workspaces[path].$dirty) continue
      await ctx.yakumo.save(path)
    }

    console.log(output.sort().join('\n'))

    const agent = manager?.name || 'npm'
    const args: string[] = agent === 'yarn' ? [] : ['install']
    const code = await spawnAsync([agent, ...args])
    if (code) process.exit(code)

    function load(path: string, meta: PackageJson) {
      delete deps[meta.name]
      for (const type of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
        for (const key in meta[type] || {}) {
          // skip workspaces and symlinks
          const value = meta[type]![key]
          const prefix = /^(npm:.+@)?/.exec(value)![0]
          const range = value.slice(prefix.length)
          if (ctx.yakumo.workspaces[key] || !'^~'.includes(range[0])) continue
          const request = (prefix ? prefix.slice(4, -1) : key) + ':' + range
          ;(((deps[request] ||= {})[path] ||= {})[type] ||= []).push(key)
        }
      }
    }
  }, {
    boolean: ['next'],
  })
}
