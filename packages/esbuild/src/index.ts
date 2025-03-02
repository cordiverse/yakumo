import { Context, z } from 'cordis'
import {} from 'yakumo'
import { load } from 'tsconfig-utils'
import dumble from 'dumble'

export const inject = ['yakumo']

export interface Config {
  minify: boolean
}

export const Config: z<Config> = z.object({
  minify: z.boolean(),
})

export function apply(ctx: Context, config: Config) {
  ctx.register('esbuild', async () => {
    const paths = ctx.yakumo.locate(ctx.yakumo.argv._)
    await Promise.all(paths.map(async (path) => {
      const cwd = ctx.yakumo.cwd + path
      const tsconfig = await load(cwd).catch(() => null)
      if (!tsconfig) return
      await dumble(cwd, ctx.yakumo.workspaces[path], tsconfig, {
        minify: ctx.yakumo.argv.minify ?? config.minify,
      })
    }))
  }, {
    boolean: ['minify'],
  })
}
