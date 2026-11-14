import { Context } from 'cordis'
import { kScriptArgs, spawnAsync } from '../index.js'

export const inject = ['yakumo', 'cli']

export function apply(ctx: Context) {
  ctx.cli
    .command('run [...packages]', 'Run scripts in packages')
    .action(async ({ args }) => {
      await ctx.yakumo.initialize()
      const { cwd } = ctx.yakumo
      const [command, ...rest] = ((globalThis as any)[kScriptArgs] as string[] | undefined) ?? []
      if (!command) throw new Error('Missing command')
      const paths = ctx.yakumo.locate(args, {
        filter: () => true,
      }).filter(path => {
        return !!ctx.yakumo.workspaces[path].scripts?.[command]
      })
      for (const path of paths) {
        await spawnAsync([ctx.yakumo.manager.name, 'run', command, ...rest], { cwd: cwd + path })
      }
    })
}
