import { Context } from 'yakumo'
import type {} from '@cordisjs/plugin-cli'
import Mocha from 'mocha'
import { globby } from 'globby'

export const inject = ['yakumo', 'cli']

export function apply(ctx: Context) {
  ctx.cli
    .command('yakumo.mocha [...packages]', 'Run tests with mocha')
    .action(async ({ args }) => {
      await ctx.yakumo.initialize()

      function getFiles(names: string[]) {
        if (!names.length) return ['**/tests/*.spec.ts']
        return names.flatMap((name) => {
          const [folder] = name.split('/', 1)
          name = name.slice(folder.length + 1) || '*'
          return ctx.yakumo.locate(folder, { includeRoot: true }).map((path) => {
            return `${path}/tests/${name}.spec.ts`.slice(1)
          })
        })
      }

      const files = await globby(getFiles(args), {
        cwd: ctx.yakumo.cwd,
        onlyFiles: true,
        ignore: ['**/node_modules/**'],
      })

      // TODO inherit mocha options
      const mocha = new Mocha()
      for (const file of files) {
        mocha.addFile(file)
      }

      const runner = mocha.run((failures) => {
        process.exit(failures)
      })

      process.on('SIGINT', () => {
        runner.abort()
      })
    })
}
