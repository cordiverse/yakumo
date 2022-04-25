import spawn from 'cross-spawn'
import globby from 'globby'
import ts from 'typescript'
import ora from 'ora'
import prompts from 'prompts'
import yaml from 'js-yaml'
import fs from 'fs'
import { writeJSON } from 'fs-extra'
import { Module } from 'module'

export const cwd = process.cwd()
export const meta: PackageJson = require(cwd + '/package.json')

export interface Config {
  mode?: 'monorepo' | 'separate' | 'submodule'
  concurrency?: number
  alias?: Record<string, string>
  require?: string[]
}

export const config: Config = {
  mode: 'monorepo',
  concurrency: 10,
  alias: {},
  require: [],
}

try {
  const source = fs.readFileSync(cwd + '/yakumo.yml', 'utf8')
  Object.assign(config, yaml.load(source))
} catch {}

const configRequire = Module.createRequire(cwd + '/yakumo.yml')

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

export class Project {
  cwd: string
  config: Config
  targets: Record<string, PackageJson>
  workspaces: Record<string, PackageJson>

  constructor(public args: readonly string[]) {
    this.cwd = cwd
    this.config = config
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

    if (!this.args.length) {
      this.targets = { ...this.workspaces }
      return
    }

    this.targets = Object.fromEntries(this.args.map((name) => {
      const path = this.locate(name)
      const meta = this.workspaces[path]
      return [path, meta] as const
    }))
  }

  private locate(name: string) {
    if (config.alias[name]) {
      return config.alias[name]
    }

    const targets = Object.keys(this.workspaces).filter((folder) => {
      const [last] = folder.split('/').reverse()
      return name === last
    })

    if (!targets.length) {
      throw new Error(`cannot find workspace "${name}"`)
    } else if (targets.length > 1) {
      throw new Error(`ambiguous workspace "${name}": ${targets.join(', ')}`)
    }

    return targets[0]
  }

  async emit(name: string) {
    return hooks[name]?.(this)
  }

  async save(path: string) {
    await writeJSON(`${cwd}${path}/package.json`, this.workspaces[path])
  }
}

export const hooks: Record<string, (project: Project) => void> = {}

export function addHook(name: string, callback: (project: Project) => void) {
  hooks[name] = callback
}

export type DependencyType = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'

export interface PackageJson extends Partial<Record<DependencyType, Record<string, string>>> {
  $dirty?: boolean
  name: string
  main?: string
  module?: string
  description?: string
  private?: boolean
  version?: string
  workspaces: string[]
}

interface Reference {
  path: string
}

export interface TsConfig {
  extends?: string
  files?: string[]
  references?: Reference[]
  compilerOptions?: ts.CompilerOptions
}

export function spawnAsync(args: string[]) {
  const child = spawn(args[0], args.slice(1), { cwd, stdio: 'inherit' })
  return new Promise<number>((resolve) => {
    child.on('close', resolve)
  })
}
