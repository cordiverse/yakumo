import ora from 'ora'
import prompts from 'prompts'
import { spawn, SpawnOptions } from 'node:child_process'
import semver from 'semver'
import type { Manifest } from '@npm/types'
import { execute } from './execute.ts'
import { isBerry } from './workspace.ts'
import type { Manager } from './index.ts'

// Raw arguments after `--`, which the CLI parser does not keep.
export const kScriptArgs = Symbol.for('yakumo.scriptArgs')

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

/** Read the registry URL from the configuration of a package manager in a directory. */
export async function getRegistry(manager: Manager, cwd?: string) {
  const key = isBerry(manager) ? 'npmRegistryServer' : 'registry'
  const { stdout } = await execute([manager.name, 'config', 'get', key], { cwd })
  const registry = stdout.trim()
  if (!URL.canParse(registry)) throw new Error(`Invalid registry from ${manager.name} config get ${key}: ${registry}`)
  // Package names resolve relative to the registry URL, which therefore ends with a slash.
  return registry.endsWith('/') ? registry : registry + '/'
}

export async function fetchRemote(name: string, registry: string) {
  const packageUrl = new URL(encodeURIComponent(name).replace(/^%40/, '@'), registry)
  const response = await fetch(packageUrl, {
    headers: {
      'Accept': 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
    },
  })
  if (!response.ok) throw new Error(`Failed to fetch ${packageUrl}`)
  return await response.json() as Manifest
}

export function selectVersion(data: Manifest, version: string) {
  if (data['dist-tags']?.[version]) {
    return data['dist-tags'][version]
  } else if (data.versions?.[version]) {
    return version
  } else if (data.versions) {
    const versions = Object.keys(data.versions)
    return semver.maxSatisfying(versions, version, { loose: true })
  }
}
