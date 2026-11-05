import { Context } from 'cordis'
import { LockOptions } from '../lock.ts'
import { isBerry } from '../workspace.ts'

export const inject = ['yakumo', 'cli']

export function apply(ctx: Context) {
  async function lock(options: LockOptions = {}) {
    await ctx.yakumo.initialize()
    const result = await ctx.yakumo.syncLocks(options)
    const skipped = result.filter(item => item.skipped).length
    const done = result.length - skipped
    console.log(`${done} repository lockfiles ${options.check ? 'checked' : 'synchronized'}${skipped ? `, ${skipped} skipped` : ''}`)
  }

  ctx.cli.command('lock [...repositories]', 'Synchronize repository lockfiles')
    .option('--immutable', 'Fail if any lockfile is outdated instead of updating it')
    .option('--strict', 'Fail on repositories that cannot be exported instead of skipping them')
    .action(async ({ args, options }) => {
      await lock({
        check: options.immutable || undefined,
        strict: options.strict || undefined,
        ...(args.length ? { repositories: args } : {}),
      })
    })

  ctx.cli.command('postinstall', 'Run post-installation tasks')
    .action(async () => {
      await ctx.yakumo.initialize()
      if (!isBerry(ctx.yakumo.manager)) return
      await lock()
    })
}
