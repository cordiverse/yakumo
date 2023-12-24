import { Context, cwd, exit, Manager, PackageJson, spawnAsync } from '..'
import { gt, prerelease } from 'semver'
import { Awaitable } from 'cosmokit'
import { join } from 'path'
import { latest } from '../utils'
import ora from 'ora'
import prompts from 'prompts'
import assert from 'assert'

declare module '..' {
  interface PackageJson {
    $copied?: boolean
  }

  interface Events {
    'publish/before'(path: string, meta: PackageJson): Awaitable<void>
    'publish/after'(path: string, meta: PackageJson): Awaitable<void>
  }
}

function getVersion(name: string, isNext = false) {
  if (isNext) {
    return latest(name, { version: 'next' }).catch(() => getVersion(name))
  } else {
    return latest(name).catch(() => '0.0.1')
  }
}

function isNext(version: string) {
  const parts = prerelease(version)
  if (!parts) return false
  return parts[0] !== 'rc'
}

function isBerry(manager: Manager) {
  return manager?.name === 'yarn' && !manager.version.startsWith('1.')
}

async function publish(manager: Manager, path: string, meta: PackageJson, args: string[], argv: any) {
  // console.log(`publishing ${name}@${version} ...`)
  if (!isBerry(manager)) {
    args = [manager?.name || 'npm', 'publish', join(cwd, path), '--color', ...args]
    return await spawnAsync(args, { stdio: argv.debug ? 'inherit' : 'ignore' })
  }
  return await spawnAsync(['yarn', 'workspace', meta.name, 'npm', 'publish', ...args], { stdio: argv.debug ? 'inherit' : 'ignore' })
}

async function parallel<S, T>(list: S[], fn: (item: S) => Promise<T>) {
  await Promise.all(list.map(fn))
}

async function serial<S, T>(list: S[], fn: (item: S) => Promise<T>) {
  for (const item of list) await fn(item)
}

export default function apply(ctx: Context) {
  ctx.register('publish', async () => {
    const { argv } = ctx.yakumo
    const spinner = ora()
    let paths = ctx.yakumo.locate(argv._, {
      filter: (meta) => {
        // 1. workspace roots are always private
        // 2. ignore private packages if not explicitly specified
        return argv._.length ? !meta.workspaces : !meta.private
      },
    })

    if (argv._.length) {
      const pending = paths.filter(path => ctx.yakumo.workspaces[path].private)
      if (pending.length) {
        const paths = pending.map(path => ctx.yakumo.workspaces[path].name).join(', ')
        const { value } = await prompts({
          name: 'value',
          type: 'confirm',
          message: `workspace ${paths} ${pending.length > 1 ? 'are' : 'is'} private, switch to public?`,
        })
        if (!value) exit('operation cancelled.')
        await Promise.all(pending.map(async (path) => {
          delete ctx.yakumo.workspaces[path].private
          await ctx.yakumo.save(path)
        }))
      }
    } else {
      let progress = 0
      spinner.start(`Loading workspaces (0/${paths.length})`)
      paths = (await Promise.all(paths.map(async (path) => {
        const meta = ctx.yakumo.workspaces[path]
        spinner.text = `Loading workspaces (${++progress}/${paths.length})`
        const version = await getVersion(meta.name, isNext(meta.version))
        if (gt(meta.version, version)) return path
      }))).filter(Boolean)
      spinner.succeed()
    }

    const total = paths.length
    if (!argv.debug) spinner.start(`Publishing packages (0/${total})`)

    let completed = 0, failed = 0
    await (argv.debug ? serial : parallel)(paths, async (path) => {
      const meta = ctx.yakumo.workspaces[path]
      try {
        await ctx.parallel('publish/before', path, meta)
        const args = [
          '--tag', argv.tag ?? (isNext(meta.version) ? 'next' : 'latest'),
          '--access', argv.access ?? 'public',
        ]
        if (argv.registry) args.push('--registry', argv.registry)
        if (argv.otp) args.push('--otp', argv.otp)
        const code = await publish(ctx.yakumo.manager, path, meta, args, argv)
        assert(!code)
        await ctx.parallel('publish/after', path, meta)
      } catch (e) {
        failed++
      } finally {
        if (!argv.debug) spinner.text = `Publishing packages (${++completed}/${total})`
      }
    })

    if (failed) {
      spinner.fail(`Published ${total - failed} packages, ${failed} failed.`)
    } else {
      spinner.succeed(`Published ${total} packages.`)
    }
  }, {
    boolean: ['debug'],
  })
}
