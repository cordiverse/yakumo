import { promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { globby } from 'globby'
import picomatch from 'picomatch'
import { valid } from 'semver'
import { parseDocument } from 'yaml'
import type { Manager, PackageJson } from './index.ts'

export interface WorkspaceGroup {
  path: string
  patterns: string[]
}

export interface WorkspaceTree {
  root: string
  packages: Record<string, PackageJson>
  groups: Record<string, WorkspaceGroup>
}

export interface DiscoverOptions {
  /**
   * Expand `workspaces` declared by nested workspaces, as Yarn 2+ does.
   * npm, pnpm and Yarn Classic only read the root declaration.
   */
  recursive?: boolean
  /** Read workspace patterns from `pnpm-workspace.yaml` instead of the `workspaces` field. */
  pnpm?: boolean
  /** Apply the order-dependent exclusions of npm. */
  npm?: boolean
}

export function discoverOptions(manager?: Manager): DiscoverOptions {
  return { recursive: isBerry(manager), pnpm: manager?.name === 'pnpm', npm: manager?.name === 'npm' }
}

/**
 * Split workspace patterns into included patterns and exclusions. Yarn and pnpm apply every
 * exclusion to every pattern of the group. npm removes a leading `./` or `/`, treats an odd
 * number of leading `!` as an exclusion, cancels an exclusion that a later pattern matches as
 * a path, drops the patterns that a remaining exclusion matches as a path, and applies the
 * remaining exclusions to every pattern.
 */
export function splitPatterns(patterns: string[], npm = false) {
  let positive: string[] = []
  let negative: string[] = []
  for (let pattern of patterns) {
    let negated = pattern.startsWith('!')
    if (npm) {
      const marks = /^!*/.exec(pattern)![0].length
      negated = marks % 2 === 1
      pattern = pattern.slice(marks).replace(/^\.?\/+/, '')
    } else if (negated) {
      pattern = pattern.slice(1)
    }
    if (negated) {
      negative.push(pattern)
    } else {
      if (npm) negative = negative.filter(exclusion => !picomatch.isMatch(pattern, exclusion))
      positive.push(pattern)
    }
  }
  if (npm) positive = positive.filter(pattern => !negative.some(exclusion => picomatch.isMatch(pattern, exclusion)))
  return { positive, negative }
}

/** Rewrite workspace patterns into an equivalent list whose exclusions apply regardless of order. */
export function normalizePatterns(patterns: string[], npm = false) {
  const { positive, negative } = splitPatterns(patterns, npm)
  return [...positive, ...negative.map(pattern => '!' + pattern)]
}

export async function readOptional(path: string) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function inside(root: string, path: string) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'))
}

export function isBerry(manager?: Manager) {
  return manager?.name === 'yarn' && !manager.version.startsWith('1.')
}

const managers = ['npm', 'pnpm', 'yarn']

/**
 * Read the package manager of a project from the `packageManager` field of its manifest.
 * Without the field, the fallback applies; without a fallback, detection fails.
 */
export async function detectManager(root: string, fallback?: Manager): Promise<Manager> {
  const meta = JSON.parse(await fs.readFile(resolve(root, 'package.json'), 'utf8'))
  const value = meta.packageManager
  if (value === undefined) {
    if (fallback) return fallback
    throw new Error(`${root}/package.json: missing packageManager, such as "packageManager": "npm@11.0.0"`)
  }
  const match = typeof value === 'string' ? /^([^@]+)@([^+]+)(\+.*)?$/.exec(value) : null
  if (!match || !valid(match[2])) throw new Error(`${root}/package.json: invalid packageManager ${JSON.stringify(value)}; expected <name>@<version>`)
  if (!managers.includes(match[1])) throw new Error(`${root}/package.json: unsupported package manager ${match[1]}; expected ${managers.join(', ')}`)
  return { name: match[1], version: match[2] }
}

export async function readPnpmWorkspace(directory: string): Promise<Record<string, any> | undefined> {
  const content = await readOptional(resolve(directory, 'pnpm-workspace.yaml'))
  if (content === undefined) return
  const document = parseDocument(content)
  if (document.errors.length) throw new Error(`Invalid ${directory}/pnpm-workspace.yaml: ${document.errors[0].message}`)
  return document.toJS() ?? {}
}

/** Replace the `packages` field of `pnpm-workspace.yaml`, preserving the other content. */
export async function writePnpmPackages(directory: string, patterns: string[]) {
  const path = resolve(directory, 'pnpm-workspace.yaml')
  const document = parseDocument(await readOptional(path) ?? '')
  document.set('packages', document.createNode(patterns))
  await fs.writeFile(path, document.toString())
}

function getPatterns(value: unknown, directory: string) {
  // Yarn Classic also accepts `{ packages: [...] }`.
  const patterns = Array.isArray(value) ? value : (value as any)?.packages
  if (!Array.isArray(patterns) || patterns.some(p => typeof p !== 'string' || isAbsolute(p.replace(/^!/, '')) || p.split('/').includes('..'))) {
    throw new Error(`Invalid workspace patterns in ${directory}`)
  }
  return patterns as string[]
}

/** Keep nested group membership separate from repository and installation boundaries. */
export async function discoverWorkspaces(root: string, options: DiscoverOptions = {}): Promise<WorkspaceTree> {
  root = resolve(root)
  const tree: WorkspaceTree = { root, packages: {}, groups: {} }
  const queue = ['']
  // Dedupe by real path so that symlinked groups cannot recurse forever.
  const seen = new Set<string>()
  while (queue.length) {
    const path = queue.shift()!
    const directory = root + path
    const real = await fs.realpath(directory)
    if (seen.has(real)) continue
    seen.add(real)
    const content = await readOptional(resolve(directory, 'package.json'))
    if (content === undefined) continue
    const meta: PackageJson = JSON.parse(content)
    tree.packages[path] = meta
    const value = options.pnpm ? (await readPnpmWorkspace(directory))?.packages : meta.workspaces
    if (!value) continue
    const group: WorkspaceGroup = { path, patterns: getPatterns(value, directory) }
    tree.groups[path] = group
    if (path && !options.recursive) continue
    // Like Yarn, negated patterns only apply to the group that declares them.
    const prefix = path ? path.slice(1) + '/' : ''
    const split = splitPatterns(group.patterns, options.npm)
    const positive = split.positive.map(p => prefix + p)
    const negative = split.negative.map(p => prefix + p)
    const folders = await globby(positive, {
      cwd: root,
      onlyDirectories: true,
      expandDirectories: false,
      followSymbolicLinks: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/.yarn/**', ...negative],
    })
    queue.push(...folders.sort().map(p => '/' + p.replace(/\/$/, '')))
  }
  return tree
}
