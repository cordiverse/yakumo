import spawn from 'cross-spawn'
import globby from 'globby'
import ora from 'ora'
import prompts from 'prompts'
import which from 'which-pm-runs'
import yargs from 'yargs-parser'
import { writeJSON } from 'fs-extra'
import { Module } from 'module'
import { Dict, makeArray, pick } from 'cosmokit'

export const cwd = process.cwd()
export const meta: PackageJson = require(cwd + '/package.json')

export interface Commands {}

export interface Config {
  alias?: Dict<string | string[]>
  require?: string[]
  commands?: Commands
}

export const config: Config = {
  alias: {},
  require: [],
  commands: {},
  ...meta.yakumo,
}

const configRequire = Module.createRequire(cwd + '/package.json')

for (const path of config.require) {
  configRequire(path)
}

export function requireSafe(id: string) {
  try {
    return require(id)
  } catch {}
}

export async function confirm(message: string) {
  const { value } = await prompts({
    name: 'value',
    type: 'confirm',
    message,
  })
  return value
}

export function exit(message: string) {
  const spinner = ora()
  spinner.info(message)
  return process.exit(0)
}

export interface Manager {
  name: string
  version: string
}

export class Project {
  cwd: string
  config: Config
  manager: Manager
  targets: Record<string, PackageJson>
  workspaces: Record<string, PackageJson>

  constructor(public argv: Arguments) {
    this.cwd = cwd
    this.config = config
    this.manager = which()
  }

  async initialize() {
    const folders = await globby(meta.workspaces, {
      cwd,
      deep: 0,
      onlyDirectories: true,
      expandDirectories: false,
    })
    folders.unshift('')

    this.workspaces = Object.fromEntries(folders.map((path) => {
      if (path) path = '/' + path
      try {
        return [path, require(`${cwd}${path}/package.json`)] as [string, PackageJson]
      } catch {}
    }).filter(Boolean))

    if (!this.argv._.length || this.argv.config.manual) {
      this.targets = { ...this.workspaces }
      return
    }

    this.targets = pick(this.workspaces, this.argv._.flatMap((name: string) => {
      return this.locate(name)
    }))
  }

  locate(name: string) {
    if (config.alias[name]) {
      return makeArray(config.alias[name]).map((path) => {
        if (!this.workspaces[path]) {
          throw new Error(`cannot find workspace ${path} resolved by ${name}`)
        }
        return path
      })
    }

    const targets = Object.keys(this.workspaces).filter((folder) => {
      if (this.workspaces[folder].private) return
      const [last] = folder.split('/').reverse()
      return name === last
    })

    if (!targets.length) {
      throw new Error(`cannot find workspace "${name}"`)
    } else if (targets.length > 1) {
      throw new Error(`ambiguous workspace "${name}": ${targets.join(', ')}`)
    }

    return targets
  }

  async emit(name: string, ...args: any) {
    await Promise.all((hooks[name] || []).map((callback) => callback.call(this, ...args)))
  }

  async save(path: string) {
    await writeJSON(`${cwd}${path}/package.json`, this.workspaces[path], { spaces: 2 })
  }
}

export interface Hooks {}

export const hooks: { [K in keyof Hooks]: Hooks[K][] } = {}

export function addHook<K extends keyof Hooks>(name: K, callback: Hooks[K]) {
  (hooks[name] ||= [] as never).push(callback)
}

type CommandCallback = (project: Project) => void

export interface Arguments extends yargs.Arguments {
  config: Options
}

export interface Options extends yargs.Options {
  manual?: boolean
}

export const commands: Record<string, [CommandCallback, Options]> = {}

export function register(name: string, callback: (project: Project) => void, options: Options = {}) {
  commands[name] = [callback, options]
}

export type DependencyType = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'

export interface PackageJson extends Partial<Record<DependencyType, Record<string, string>>> {
  name: string
  main?: string
  module?: string
  description?: string
  private?: boolean
  version?: string
  workspaces: string[]
  yakumo?: Config
}

export function spawnAsync(args: string[]) {
  const child = spawn(args[0], args.slice(1), { cwd, stdio: 'inherit' })
  return new Promise<number>((resolve) => {
    child.on('close', resolve)
  })
}
