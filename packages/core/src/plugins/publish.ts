import { Context } from 'cordis'
import { exit, Manager, PackageJson, spawnAsync } from '../index.js'
import { lt, maxSatisfying, prerelease } from 'semver'
import { Awaitable } from 'cosmokit'
import { join } from 'node:path'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { fetchRemote } from '../utils.js'
import ora from 'ora'
import prompts from 'prompts'
import assert from 'node:assert'

declare module '../index.js' {
  interface PackageJson {
    $copied?: boolean
  }
}

export interface PublishOptions {
  /** Run the publish command of the package manager without uploading the package. */
  dryRun: boolean
}

declare module 'cordis' {
  interface Events {
    'yakumo/publish'(path: string, meta: PackageJson, options: PublishOptions, next: () => Awaitable<void>): Promise<void>
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

function publishCommand(manager: Manager, cwd: string, path: string, meta: PackageJson, args: string[]) {
  if (isBerry(manager)) return ['yarn', 'workspace', meta.name, 'npm', 'publish', ...args]
  // pnpm requires a clean default branch unless Git checks are disabled; Yakumo checks versions itself.
  if (manager.name === 'pnpm') args = [...args, '--no-git-checks']
  return [manager.name, 'publish', join(cwd, path), '--color', ...args]
}

const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/**
 * Replace a file while a task runs, and restore its content afterwards, also when the
 * process exits or receives a termination signal during the task.
 */
async function withContent<T>(file: string, content: string, task: () => Promise<T>) {
  const original = await readFile(file, 'utf8')
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    writeFileSync(file, original)
  }
  const onSignal = (signal: NodeJS.Signals) => {
    restore()
    cleanup()
    // Terminate with the default action of the signal, as without the listener.
    process.kill(process.pid, signal)
  }
  const cleanup = () => {
    process.off('exit', restore)
    for (const signal of signals) process.off(signal, onSignal)
  }
  process.on('exit', restore)
  for (const signal of signals) process.on(signal, onSignal)
  try {
    await writeFile(file, content)
    return await task()
  } finally {
    restore()
    cleanup()
  }
}

async function parallel<S, T>(list: S[], fn: (item: S) => Promise<T>) {
  await Promise.all(list.map(fn))
}

async function serial<S, T>(list: S[], fn: (item: S) => Promise<T>) {
  for (const item of list) await fn(item)
}

export const inject = ['yakumo', 'cli']

export function apply(ctx: Context) {
  ctx.cli
    .command('publish [...packages]', 'Publish packages to npm')
    .option('--debug', 'Verbose output')
    .option('--tag [tag]', 'npm dist-tag')
    .option('--access [access]', 'npm access level')
    .option('--registry [registry]', 'npm registry URL')
    .option('--otp [otp]', 'npm OTP code')
    .option('--dry-run', 'Check versions and run the publish command of the package manager without uploading')
    .option('--fail-if-empty', 'Exit with a non-zero code when no package is published')
    .action(async ({ args, options }) => {
      await ctx.yakumo.initialize()
      const { manager } = ctx.yakumo
      const dryRun = !!options.dryRun
      const failIfEmpty = !!options.failIfEmpty
      if (dryRun && manager.name === 'yarn' && lt(manager.version, '4.10.0')) {
        throw new Error(`publish --dry-run requires Yarn 4.10 or later, found ${manager.version}`)
      }
      // A dry run shows the output of the package manager, which lists the packed files.
      const verbose = !!options.debug || dryRun
      const spinner = ora()
      let paths = ctx.yakumo.locate(args, {
        filter: (meta, path) => {
          // 1. workspace roots are always private
          // 2. ignore private packages unless explicitly specified
          return args.length ? !ctx.yakumo.workspaceTree.groups[path] : !meta.private
        },
      })

      if (args.length) {
        const pending = paths.filter(path => ctx.yakumo.workspaces[path].private)
        if (pending.length && dryRun) {
          const names = pending.map(path => ctx.yakumo.workspaces[path].name).join(', ')
          spinner.info(`workspace ${names} ${pending.length > 1 ? 'are' : 'is'} private and would be switched to public.`)
        } else if (pending.length) {
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
        path?: string
        ranges: Record<string, string>
      }
      const constraints: Record<string, Constraint> = Object.create(null)
      for (const path of paths) {
        const meta = ctx.yakumo.workspaces[path]
        const constraint = constraints[meta.name] ??= { ranges: Object.create(null) }
        constraint.path = path
        for (const [dep, range] of Object.entries({ ...meta.peerDependencies, ...meta.dependencies })) {
          const constraint = constraints[dep] ??= { ranges: Object.create(null) }
          constraint.ranges[meta.name] = range
        }
      }

      interface PublishResult {
        name: string
        version: string
        status: 'published' | 'skipped' | 'failed'
        error?: string
      }
      const results: PublishResult[] = []

      let progress = 0, hasError = false
      let total = Object.keys(constraints).length
      spinner.start(`Checking versions (0/${total})`)
      paths = []
      await Promise.all(Object.entries(constraints).map(async ([name, constraint]) => {
        const versions: string[] = await ctx.yakumo.registry().then(registry => fetchRemote(name, registry)).then((data) => Object.keys(data.versions), () => [])
        let hasMessage = false
        if (constraint.path) {
          const meta = ctx.yakumo.workspaces[constraint.path]
          if (versions.includes(meta.version)) {
            results.push({ name, version: meta.version, status: 'skipped' })
          } else {
            versions.push(meta.version)
            paths.push(constraint.path)
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
      if (!verbose && total > 0) {
        spinner.start(`Publishing packages (0/${total})`)
      }

      let completed = 0
      await (verbose ? serial : parallel)(paths, async (path) => {
        const meta = ctx.yakumo.workspaces[path]
        try {
          await ctx.waterfall('yakumo/publish', path, meta, { dryRun }, async () => {
            const args = [
              '--tag', options.tag ?? (isNext(meta.version) ? 'next' : 'latest'),
              '--access', options.access ?? 'public',
            ]
            if (options.registry) args.push('--registry', options.registry)
            if (options.otp) args.push('--otp', options.otp)
            if (dryRun) args.push('--dry-run')
            const command = publishCommand(manager, ctx.yakumo.cwd, path, meta, args)
            const run = () => spawnAsync(command, { cwd: ctx.yakumo.cwd, stdio: verbose ? 'inherit' : 'ignore' })
            let code: number
            if (dryRun && meta.private && isBerry(manager)) {
              // Yarn rejects private workspaces even in a dry run. A publish would make the
              // package public first, so the manifest is public while Yarn runs.
              const file = join(ctx.yakumo.cwd + path, 'package.json')
              const manifest = JSON.parse(await readFile(file, 'utf8'))
              delete manifest.private
              code = await withContent(file, JSON.stringify(manifest, null, ctx.yakumo.indent) + '\n', run)
            } else {
              code = await run()
            }
            assert(!code)
            if (dryRun) return
            // sync npm mirror
            fetch('https://registry-direct.npmmirror.com/' + meta.name + '/sync?sync_upstream=true', {
              method: 'PUT',
            }).catch(() => {})
          })
          results.push({ name: meta.name, version: meta.version, status: 'published' })
        } catch (e) {
          results.push({ name: meta.name, version: meta.version, status: 'failed', error: String(e) })
        } finally {
          if (!verbose) spinner.text = `Publishing packages (${++completed}/${total})`
        }
      })

      const skipped = results.filter(r => r.status === 'skipped').length
      const published = results.filter(r => r.status === 'published').length
      const failed = results.filter(r => r.status === 'failed').length

      const skippedText = skipped ? `, ${skipped} skipped` : ''
      const publishedText = dryRun ? `Dry run: ${published} packages would be published` : `Published ${published} packages`
      // Opt-in: a push-to-main workflow publishes on every commit, where nothing to
      // publish is normal. CI that expects a release can pass --fail-if-empty so a
      // forgotten version bump shows up as a failure instead of a green run.
      const empty = failIfEmpty && results.length > 0 && published === 0
      if (failed) {
        spinner.fail(`${publishedText}, ${failed} failed${skippedText}.`)
      } else if (empty) {
        spinner.fail(`${publishedText}${skippedText}.`)
      } else {
        spinner.succeed(`${publishedText}${skippedText}.`)
      }

      if (results.length) {
        results.sort((a, b) => a.name.localeCompare(b.name))
        console.log()
        const labels = { published: dryRun ? 'would publish' : 'published', skipped: 'skipped', failed: 'failed' }
        const width = Math.max(...Object.values(labels).map(label => label.length)) + 2
        for (const r of results) {
          console.log(`${labels[r.status].padStart(width)}  ${r.name}@${r.version}`)
          if (r.error) console.log(`${' '.repeat(width + 2)}${r.error}`)
        }
      }

      if (process.env.GITHUB_STEP_SUMMARY && results.length) {
        const icon = (s: PublishResult['status']) =>
          s === 'published' ? (dryRun ? ':test_tube: Would publish' : ':white_check_mark: Published')
            : s === 'skipped' ? ':fast_forward: Skipped'
              : ':x: Failed'
        const lines = [
          dryRun ? '## Publish Summary (Dry Run)' : '## Publish Summary',
          '',
          `${dryRun ? 'Would publish' : 'Published'} ${published}, skipped ${skipped}, failed ${failed}.`,
          '',
          '| Package | Version | Status |',
          '| --- | --- | --- |',
          ...results.map(r => `| \`${r.name}\` | \`${r.version}\` | ${icon(r.status)} |`),
          '',
        ]
        await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n')).catch(() => {})
      }

      if (failed) process.exit(Math.min(failed, 255))
      if (empty) process.exit(1)
    })
}
