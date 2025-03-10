import { Context, Service } from 'cordis'
import globby from 'globby'
import yargs from 'yargs-parser'
import detect from 'detect-indent'
import { manager, spawnAsync } from './utils.ts'
import kleur from 'kleur'
import { promises as fs, readFileSync } from 'node:fs'
import { deduplicate, Dict, isNonNullable, makeArray } from 'cosmokit'

export * from 'cordis'
export * from './utils.ts'

declare module 'cordis' {
  interface Context {
    yakumo: Yakumo
    register(name: string, callback: () => void, options?: Options): void
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

export interface Arguments extends yargs.Arguments {
  config: Options
  _: string[]
}

export interface Options extends yargs.Options {}

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

const builtin = [
  'list',
  'prepare',
  'publish',
  'run',
  'test',
  'upgrade',
  'version',
]

export default class Yakumo extends Service {
  cwd: string
  argv!: Arguments
  manager: Manager
  workspaces!: Dict<PackageJson>
  indent = detect(content).indent
  commands: Dict = {}

  constructor(public ctx: Context, public config: Yakumo.Config) {
    super(ctx, 'yakumo')
    ctx.mixin('yakumo', ['register'])
    this.cwd = cwd
    this.manager = manager

    for (const name in config.pipeline || {}) {
      this.register(name, async (...rest: any[]) => {
        const tasks = config.pipeline![name]
        for (const task of tasks) {
          const [name, ...args] = task.split(/\s+/g)
          await this.execute(name, ...args, ...rest)
        }
      })
    }
  }

  register(name: string, callback: () => void, options: Options = {}) {
    this.commands[name] = [callback, options]
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

  async execute(name: string, ...args: string[]) {
    if (!this.commands[name]) {
      if (builtin.includes(name)) {
        await this.ctx.get('loader')?.create({
          name: 'yakumo/' + name,
        })
        return this.execute(name, ...args)
      }
      console.error(kleur.red(`unknown command: ${name}`))
      process.exit(1)
    }

    const [callback, options] = this.commands[name]
    const index = args.indexOf('--')
    const rest = index === -1 ? [] : args.splice(index + 1)
    const argv = yargs(args, options) as Arguments
    argv['--'] = rest
    await this.initialize()
    if (!name.startsWith('yakumo:') && name !== 'run') {
      await this.execute('run', ...argv._, '--', `yakumo:before:${name}`)
    }
    argv.config = options
    this.argv = argv
    await callback(...args)
    if (!name.startsWith('yakumo:') && name !== 'run') {
      await this.execute('run', ...argv._.slice(0, index === -1 ? undefined : index), '--', `yakumo:after:${name}`)
    }
  }

  start() {
    const loader = this.ctx.get('loader')
    if (loader?.config.name !== 'yakumo') return
    const [name, ...args] = process.argv.slice(2)
    if (!name) {
      console.log('yakumo')
      process.exit(0)
    }
    loader.wait().then(() => {
      return this.execute(name, ...args)
    })
  }

  async install() {
    const agent = manager?.name || 'npm'
    const code = await spawnAsync([agent, 'install'])
    if (code) process.exit(code)
  }
}
