import { Context } from 'cordis'
import { cwd, exit, Manager, PackageJson, spawnAsync } from '../index.js'
import { maxSatisfying, prerelease } from 'semver'
import { Awaitable } from 'cosmokit'
import { join } from 'node:path'
import { fetchRemote } from '../utils.js'
import ora from 'ora'
import prompts from 'prompts'
import assert from 'node:assert'

declare module '../index.js' {
  interface PackageJson {
    $copied?: boolean
  }
}

declare module 'cordis' {
  interface Events {
    'publish/before'(path: string, meta: PackageJson): Awaitable<void>
    'publish/after'(path: string, meta: PackageJson): Awaitable<void>
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

export const inject = ['yakumo']

export function apply(ctx: Context) {
  ctx.register('publish', async () => {
    const { argv } = ctx.yakumo
    const spinner = ora()
    let paths = ctx.yakumo.locate(argv._, {
      filter: (meta) => {
        // 1. workspace roots are always private
        // 2. ignore private packages unless explicitly specified
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
    }

    interface Constraint {
      meta?: PackageJson
      ranges: Record<string, string>
    }
    const constraints: Record<string, Constraint> = Object.create(null)
    for (const path of paths) {
      const meta = ctx.yakumo.workspaces[path]
      const task = constraints[meta.name] ??= { ranges: Object.create(null) }
      task.meta = meta
      for (const [dep, range] of Object.entries({ ...meta.peerDependencies, ...meta.dependencies })) {
        const task = constraints[dep] ??= { ranges: Object.create(null) }
        task.ranges[meta.name] = range
      }
    }

    let progress = 0, skipped = 0, hasError = false
    let total = Object.keys(constraints).length
    spinner.start(`Checking versions (0/${total})`)
    paths = []
    await Promise.all(Object.entries(constraints).map(async ([name, constraint]) => {
      const versions: string[] = await fetchRemote(name).then((data) => Object.keys(data.versions), () => [])
      let hasMessage = false
      if (constraint.meta) {
        if (versions.includes(constraint.meta.version)) {
          spinner.warn(`${name}@${constraint.meta.version} already published.`)
          hasMessage = true
          skipped += 1
        } else {
          versions.push(constraint.meta.version)
          paths.push(constraint.meta.name)
        }
      }
      for (const [from, range] of Object.entries(constraint.ranges)) {
        if (!maxSatisfying(versions, range, { includePrerelease: true })) {
          spinner.fail(`${from} > ${name}@${range} cannot be satisfied.`)
          hasMessage = true
          hasError = true
        }
      }
      if (hasMessage) {
        spinner.start(`Checking versions (${++progress}/${total})`)
      } else {
        spinner.text = `Checking versions (${++progress}/${total})`
      }
    }))
    if (hasError) {
      spinner.fail('Some version checks failed.')
      process.exit(1)
    }
    spinner.succeed()

    total = paths.length
    if (!argv.debug && total > 0) {
      spinner.start(`Publishing packages (0/${total})`)
    }

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
        // sync npm mirror
        fetch('https://registry-direct.npmmirror.com/' + meta.name + '/sync?sync_upstream=true', {
          method: 'PUT',
        }).catch(() => {})
        await ctx.parallel('publish/after', path, meta)
      } catch (e) {
        failed++
      } finally {
        if (!argv.debug) spinner.text = `Publishing packages (${++completed}/${total})`
      }
    })

    const skippedText = skipped ? `, ${skipped} skipped` : ''
    if (failed) {
      spinner.fail(`Published ${total - failed} packages, ${failed} failed${skippedText}.`)
    } else {
      spinner.succeed(`Published ${total} packages${skippedText}.`)
    }
  }, {
    boolean: ['debug'],
  })
}
