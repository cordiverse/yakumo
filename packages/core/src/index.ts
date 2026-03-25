import { Context, Inject, Service } from 'cordis'
import { Input } from '@cordisjs/plugin-cli'
import { globby } from 'globby'
import detect from 'detect-indent'
import { manager, spawnAsync } from './utils.ts'
import { promises as fs, readFileSync } from 'node:fs'
import { deduplicate, Dict, isNonNullable, makeArray } from 'cosmokit'

export * from 'cordis'
export * from './utils.ts'

declare module 'cordis' {
  interface Context {
    yakumo: Yakumo
  }

  interface Intercept {
    yakumo: Yakumo.Intercept
  }
}

export const cwd = process.cwd()
const content = readFileSync(`${cwd}/package.json`, 'utf8')
export const meta: PackageJson = JSON.parse(content)

export interface PackageConfig {}

export interface Manager {
  name: string
  version: string
}

export type DependencyType = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'

export interface PackageJson extends Partial<Record<DependencyType, Dict<string>>> {
  name: string
  type?: 'module' | 'commonjs'
  main?: string
  module?: string
  bin?: string | Dict<string>
  exports?: PackageJson.Exports
  description?: string
  private?: boolean
  version: string
  workspaces?: string[]
  scripts?: Dict<string>
  yakumo?: PackageConfig
  peerDependenciesMeta?: Dict<{ optional?: boolean }>
}

export namespace PackageJson {
  export type Exports = string | { [key: string]: Exports }
}

export interface LocateOptions {
  includeRoot?: boolean
  filter?(meta: PackageJson, path: string): boolean
}

export namespace Yakumo {
  export interface Intercept {
    alias?: Dict<string | string[]>
    exclude?: string[]
  }

  export interface Config extends Intercept {
    commands?: Dict
    pipeline?: Dict<string[]>
  }
}

@Inject('cli')
export default class Yakumo extends Service {
  cwd: string
  manager: Manager
  workspaces!: Dict<PackageJson>
  indent = detect(content).indent
  commands: Dict = {}

  constructor(public ctx: Context, public config: Yakumo.Config) {
    super(ctx, 'yakumo')
    this.cwd = cwd
    this.manager = manager

    ctx.cli.command('yakumo', 'monorepo manager for JavaScript/TypeScript projects')

    // Register pipeline commands (command aliases that run multiple sub-commands)
    for (const name in config.pipeline || {}) {
      ctx.cli
        .command(`yakumo.${name} [...args]`, { unknownOption: 'allow' })
        .action(async ({ args, options }) => {
          const tasks = config.pipeline![name]
          for (const task of tasks) {
            await ctx.cli.execute(new Input.String(task), args, options)
          }
        })
    }
  }

  async initialize() {
    const folders = await globby(meta.workspaces || [], {
      cwd,
      onlyDirectories: true,
      expandDirectories: false,
    })
    folders.unshift('')

    this.workspaces = Object.fromEntries((await Promise.all(folders.map(async (path) => {
      if (path) path = '/' + path
      try {
        const content = await fs.readFile(`${cwd}${path}/package.json`, 'utf8')
        return [path, JSON.parse(content)] as [string, PackageJson]
      } catch {}
    }))).filter(isNonNullable))
  }

  resolveIntercept(): Yakumo.Intercept {
    let result = this.config
    let intercept = this.ctx[Context.intercept]
    while (intercept) {
      result = {
        ...result,
        ...intercept.yakumo,
        alias: {
          ...result.alias,
          ...intercept.yakumo?.alias,
        },
        exclude: [
          ...result.exclude || [],
          ...intercept.yakumo?.exclude || [],
        ],
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    return result
  }

  locate(name: string | string[], options: LocateOptions = {}): string[] {
    const { alias = {}, exclude } = this.resolveIntercept()
    const defaultFilter = options.filter || ((meta) => options.includeRoot || !meta.workspaces)
    const filter = (meta: PackageJson, path: string) => {
      return defaultFilter(meta, path) && !exclude?.some((pattern) => {
        return new RegExp('^/' + pattern.replace(/\*/g, '[^/]+') + '$').test(path)
      })
    }
    if (Array.isArray(name)) {
      if (!name.length) {
        return Object.keys(this.workspaces).filter((folder) => {
          return filter(this.workspaces[folder], folder)
        })
      } else {
        return deduplicate(name.flatMap((name) => this.locate(name, options)))
      }
    }

    if (alias[name]) {
      return makeArray(alias[name]).map((path) => {
        if (!this.workspaces[path]) {
          throw new Error(`cannot find workspace ${path} resolved by ${name}`)
        }
        return path
      })
    }

    for (const key in alias) {
      if (!key.endsWith('*')) continue
      if (!name.startsWith(key.slice(0, -1))) continue
      const results = makeArray(alias[key])
        .map((path) => path.slice(0, -1) + name.slice(key.length - 1))
        .filter((path) => this.workspaces[path])
      if (results.length) return results
    }

    const targets = Object.keys(this.workspaces).filter((folder) => {
      if (!filter(this.workspaces[folder], folder)) return
      return folder.endsWith('/' + name)
    })

    if (!targets.length) {
      throw new Error(`cannot find workspace "${name}"`)
    } else if (targets.length > 1) {
      throw new Error(`ambiguous workspace "${name}": ${targets.join(', ')}`)
    }

    return targets
  }

  async save(path: string) {
    const content = JSON.stringify(this.workspaces[path], null, this.indent) + '\n'
    await fs.writeFile(`${cwd}${path}/package.json`, content)
  }

  async install() {
    const agent = manager?.name || 'npm'
    const code = await spawnAsync([agent, 'install'])
    if (code) process.exit(code)
  }
}
