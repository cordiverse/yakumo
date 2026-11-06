import { posix, resolve } from 'node:path'
import { parseAllDocuments, stringify } from 'yaml'
import { readPnpmWorkspace } from '../workspace.ts'
import { Adapter, assertExtensions, assertPortable, assertRegistrySpecifier, copyOptional, exists, major, UnsupportedError, writeManifests } from './shared.ts'

const importerFields = ['dependencies', 'devDependencies', 'optionalDependencies']
const graphFields = ['importers', 'packages', 'snapshots', 'time']

interface Lockfile {
  /** The document that records configuration and package manager dependencies, if any. */
  env?: Record<string, any>
  main: Record<string, any>
}

function parse(content: string): Lockfile {
  const documents = parseAllDocuments(content)
  if (!Array.isArray(documents)) return { main: {} }
  const values = documents.map((document) => {
    if (document.errors.length) throw new Error(`Invalid pnpm-lock.yaml: ${document.errors[0].message}`)
    return document.toJS()
  }).filter(Boolean)
  return values.length > 1 ? { env: values[0], main: values.at(-1) } : { main: values[0] ?? {} }
}

/** Key of the snapshot that a dependency reference of the lockfile points to. */
function snapshotKey(name: string, reference: string) {
  if (reference.startsWith('link:')) return
  if (reference.startsWith('@')) return reference
  const at = reference.indexOf('@')
  if (at < 0) return `${name}@${reference}`
  const colon = reference.indexOf(':')
  const paren = reference.indexOf('(')
  if ((colon < 0 || at < colon) && (paren < 0 || at < paren)) return reference
  return `${name}@${reference}`
}

/** Keep the packages and snapshots that the importers reach. */
function prune(lock: Record<string, any>) {
  const snapshots: Record<string, any> = {}
  const packages: Record<string, any> = {}
  const time: Record<string, any> = {}
  const queue: string[] = []
  const visit = (name: string, reference: unknown) => {
    if (typeof reference !== 'string') return
    const key = snapshotKey(name, reference)
    if (!key || key in snapshots || !lock.snapshots?.[key]) return
    snapshots[key] = lock.snapshots[key]
    queue.push(key)
  }
  for (const importer of Object.values<any>(lock.importers || {})) {
    for (const field of importerFields) {
      for (const [name, dependency] of Object.entries<any>(importer[field] || {})) visit(name, dependency?.version)
    }
  }
  while (queue.length) {
    const key = queue.pop()!
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [name, reference] of Object.entries(snapshots[key][field] || {})) visit(name, reference)
    }
    const id = key.replace(/\(.*$/, '')
    if (lock.packages?.[id]) packages[id] = lock.packages[id]
    if (lock.time?.[id]) time[id] = lock.time[id]
  }
  lock.packages = packages
  lock.snapshots = snapshots
  if (lock.time) lock.time = time
}

/**
 * Map the importers of the root lockfile into the repository. A link to a project outside
 * the repository is replaced by the dependency of the previous repository lockfile. The
 * configuration recorded by the previous repository lockfile is kept; pnpm updates it when
 * the repository configuration differs.
 *
 * The seed omits the document of package manager dependencies. pnpm resolves it again and
 * writes the whole lockfile, which also replaces the formatting of the seed with its own.
 * With an up-to-date document, pnpm would leave the seed unchanged.
 */
export function seedPnpm(root: string, previous: string | undefined, prefix: string, projects: string[]) {
  const source = parse(root).main
  const old = previous ? parse(previous).main : undefined
  const importerKeys = new Set(projects.map(project => project || '.'))
  const remap = (path: string) => path === prefix ? '.' : path.startsWith(prefix + '/') ? path.slice(prefix.length + 1) : undefined
  const importers: Record<string, any> = {}
  for (const [path, importer] of Object.entries<any>(old?.importers || {})) {
    if (importerKeys.has(path)) importers[path] = structuredClone(importer)
  }
  for (const [path, original] of Object.entries<any>(source.importers || {})) {
    const target = remap(path)
    if (target === undefined || !importerKeys.has(target)) continue
    const importer = structuredClone(original)
    for (const field of importerFields) {
      for (const [name, dependency] of Object.entries<any>(importer[field] || {})) {
        if (typeof dependency?.version !== 'string' || !dependency.version.startsWith('link:')) continue
        if (remap(posix.normalize(posix.join(path, dependency.version.slice(5)))) !== undefined) continue
        const fallback = old?.importers?.[target]?.[field]?.[name]
        if (fallback) importer[field][name] = fallback
        else delete importer[field][name]
      }
    }
    importers[target] = importer
  }
  const header = Object.fromEntries(Object.entries(old ?? { lockfileVersion: source.lockfileVersion, settings: source.settings })
    .filter(([key, value]) => !graphFields.includes(key) && value !== undefined))
  const main: Record<string, any> = { ...header, importers }
  for (const field of ['packages', 'snapshots', 'time']) {
    if (source[field] || old?.[field]) main[field] = { ...old?.[field], ...source[field] }
  }
  prune(main)
  return stringify(main, { lineWidth: 0 })
}

function assertOverrides(overrides: Record<string, unknown> | undefined, label: string) {
  for (const value of Object.values(overrides || {})) {
    if (typeof value !== 'string') continue
    // `-` removes a dependency; `$name` refers to the specifier of a direct dependency.
    if (value === '-' || value.startsWith('$') || value.startsWith('catalog:')) continue
    assertRegistrySpecifier(value, label)
  }
}

function assertSpecifier(specifier: string, label: string) {
  // Catalog entries are validated with the workspace configuration.
  if (!specifier.startsWith('catalog:')) assertRegistrySpecifier(specifier, label)
}

export const pnpm: Adapter = {
  filename: 'pnpm-lock.yaml',
  versions: 'pnpm 9 or later',
  supports: version => major(version) >= 9,
  discover: { pnpm: true },
  async stage(tree, directory) {
    const config = await readPnpmWorkspace(tree.root) || {}
    const legacy = (tree.packages[''] as any).pnpm || {}
    const label = `${tree.root}/pnpm-workspace.yaml`
    if (config.patchedDependencies || legacy.patchedDependencies || config.pnpmfile || config.globalPnpmfile
      || await exists(resolve(tree.root, '.pnpmfile.cjs')) || await exists(resolve(tree.root, '.pnpmfile.mjs'))) {
      throw new UnsupportedError(`${tree.root}: pnpmfiles and patches need an explicit standalone layout`)
    }
    if (config.sharedWorkspaceLockfile === false || config.useGitBranchLockfile || config.lockfile === false) {
      throw new UnsupportedError(`${label}: standalone lockfile export requires a single shared lockfile`)
    }
    assertPortable(tree, assertSpecifier)
    for (const catalog of [config.catalog, ...Object.values<any>(config.catalogs || {})]) {
      for (const specifier of Object.values<string>(catalog || {})) assertRegistrySpecifier(specifier, `${label}: catalogs`)
    }
    assertOverrides(config.overrides, `${label}: overrides`)
    assertOverrides(legacy.overrides, `${tree.root}: pnpm.overrides`)
    assertOverrides((tree.packages[''] as any).resolutions, `${tree.root}: resolutions`)
    assertExtensions(config.packageExtensions, `${label}: packageExtensions`)
    assertExtensions(legacy.packageExtensions, `${tree.root}: pnpm.packageExtensions`)
    await writeManifests(tree, directory)
    await copyOptional(resolve(tree.root, 'pnpm-workspace.yaml'), resolve(directory, 'pnpm-workspace.yaml'))
    await copyOptional(resolve(tree.root, '.npmrc'), resolve(directory, '.npmrc'))
  },
  seed: seedPnpm,
  // CI enables frozen lockfiles by default.
  args: ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'],
  verify(content) {
    const { lockfileVersion } = parse(content).main
    if (String(lockfileVersion) !== '9.0') throw new Error(`pnpm wrote lockfileVersion ${lockfileVersion}; expected 9.0`)
  },
}
