import { Context } from 'yakumo'
import { load } from 'tsconfig-utils'
import dumble from 'dumble'
import type { BuildOptions } from 'esbuild'
import type {} from '@cordisjs/plugin-cli'
import z from 'schemastery'

declare module 'yakumo' {
  interface Events {
    'yakumo/esbuild'(path: string, options: BuildOptions, next: () => Promise<void>): Promise<void>
  }
}

export const inject = ['yakumo', 'cli']

export interface Config {
  minify: boolean
}

export const Config: z<Config> = z.object({
  minify: z.boolean(),
})

export function apply(ctx: Context, config: Config) {
  ctx.cli
    .command('esbuild [...packages]', 'Build packages with esbuild')
    .option('--minify', 'Minify output')
    .action(async ({ args, options }) => {
      await ctx.yakumo.initialize()
      const paths = ctx.yakumo.locate(args)
      await Promise.all(paths.map(async (path) => {
        const cwd = ctx.yakumo.cwd + path
        const tsconfig = await load(cwd).catch(() => null)
        if (!tsconfig) return
        await dumble(cwd, ctx.yakumo.workspaces[path], tsconfig, {
          minify: options.minify ?? config.minify,
          build: async (options, callback) => {
            await ctx.waterfall('yakumo/esbuild', path, options, async () => {
              await callback(options)
            })
          },
        })
      }))
    })
}
