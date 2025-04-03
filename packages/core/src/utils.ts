import ora from 'ora'
import prompts from 'prompts'
import which from 'which-pm-runs'
import { spawn, SpawnOptions } from 'node:child_process'
import getRegistry from 'get-registry'
import semver from 'semver'
import { PackageJson } from '.'

export async function confirm(message: string) {
  const { value } = await prompts({
    name: 'value',
    type: 'confirm',
    message,
  })
  return value as boolean
}

export function exit(message: string) {
  const spinner = ora()
  spinner.info(message)
  return process.exit(0)
}

export function spawnAsync(args: string[], options: SpawnOptions = {}) {
  const child = spawn(args[0], args.slice(1), options)
  return new Promise<number>((resolve) => {
    child.stderr?.pipe(process.stderr)
    child.stdout?.pipe(process.stdout)
    child.on('close', resolve)
  })
}

export const manager = which()!

export async function install() {
  const agent = manager?.name || 'npm'
  const code = await spawnAsync([agent, 'install'])
  if (code) process.exit(code)
}

export interface User {
  name?: string
  email: string
  url?: string
  username?: string
}

export interface RemotePackage extends PackageJson {
  deprecated?: string
  author?: User
  contributors?: User[]
  maintainers: User[]
  license: string
  dist: RemotePackage.Dist
}

export namespace RemotePackage {
  export interface Dist {
    shasum: string
    integrity: string
    tarball: string
    fileCount: number
    unpackedSize: number
  }
}

export interface RegistryPackage extends PackageJson {
  versions: Record<string, PackageJson>
  time: Record<string, string>
  license: string
  readme: string
  readmeFilename: string
  'dist-tags': Record<string, string>
}

let registryTask: Promise<string | undefined>

export async function fetchRemote(name: string) {
  const registry = await (registryTask ||= getRegistry())
  const packageUrl = new URL(encodeURIComponent(name).replace(/^%40/, '@'), registry)
  const response = await fetch(packageUrl, {
    headers: {
      'Accept': 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
    },
  })
  if (!response.ok) throw new Error(`Failed to fetch ${packageUrl}`)
  return await response.json() as RegistryPackage
}

export function selectVersion(data: RegistryPackage, version: string) {
  if (data['dist-tags'][version]) {
    return data['dist-tags'][version]
  } else if (data.versions?.[version]) {
    return version
  } else {
    const versions = Object.keys(data.versions)
    return semver.maxSatisfying(versions, version, { loose: true })
  }
}
