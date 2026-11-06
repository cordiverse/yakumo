import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { parseSyml, stringifySyml } from '@yarnpkg/parsers'
import { readOptional } from '../workspace.ts'
import { Adapter, assertExtensions, assertPortable, assertRegistrySpecifier, major, UnsupportedError, writeManifests } from './shared.ts'

/** Reuse registry records, never workspace locators rooted in a different project. */
export function seedYarn(root: string, previous?: string) {
  const source = parseSyml(root)
  if (!source.__metadata) throw new Error('Yarn Classic lockfiles are not supported')
  const seed: Record<string, any> = { __metadata: source.__metadata }
  for (const lock of [previous ? parseSyml(previous) : {}, source]) {
    for (const [key, entry] of Object.entries<any>(lock)) {
      if (!entry?.resolution || !/^(@[^/]+\/)?[^@]+@npm:/.test(entry.resolution)) continue
      for (const descriptor of key.split(/, /)) seed[descriptor] = entry
    }
  }
  return stringifySyml(seed)
}

export const yarn: Adapter = {
  filename: 'yarn.lock',
  versions: 'Yarn 4',
  supports: version => major(version) === 4,
  discover: { recursive: true },
  checkEnv(env) {
    if (env.YARN_RC_FILENAME && env.YARN_RC_FILENAME !== '.yarnrc.yml') {
      throw new Error('Custom YARN_RC_FILENAME is not supported by lockfile synchronization')
    }
  },
  async stage(tree, directory, manager) {
    assertPortable(tree)
    await writeManifests(tree, directory, (meta, path) => {
      // The staging directory has no ancestor manifest, so Corepack resolves `yarn` from this field.
      if (!path) (meta as any).packageManager ||= `yarn@${manager.version}`
      for (const specifier of Object.values<string>((meta as any).resolutions || {})) {
        assertRegistrySpecifier(specifier, `${tree.root + path}: resolutions`)
      }
    })
    const rc = await readOptional(resolve(tree.root, '.yarnrc.yml'))
    const config = rc === undefined ? {} : parseSyml(rc)
    if (config.plugins?.length || config.yarnPath || config.patchFolder || config.injectEnvironmentFiles?.length) {
      throw new UnsupportedError(`${tree.root}: custom Yarn plugins, releases, environment files and patches need an explicit standalone layout`)
    }
    assertExtensions(config.packageExtensions, `${tree.root}: packageExtensions`)
    delete config.plugins
    await fs.writeFile(resolve(directory, '.yarnrc.yml'), stringifySyml({
      ...config,
      installStatePath: resolve(directory, '.yarn/install-state.gz'),
      enableScripts: false,
      enableImmutableInstalls: false,
      enableTelemetry: false,
    }))
  },
  seed: (root, previous) => seedYarn(root, previous),
  args: ['install', '--mode=update-lockfile'],
  env: directory => ({
    YARN_ENABLE_SCRIPTS: 'false',
    YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
    YARN_INSTALL_STATE_PATH: resolve(directory, '.yarn/install-state.gz'),
  }),
  verify(content) {
    if (!parseSyml(content).__metadata) throw new Error('Yarn did not write a Yarn 2+ lockfile')
  },
}
