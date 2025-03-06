import { Context } from 'cordis'
import {} from 'yakumo'
import Mocha from 'mocha'
import globby from 'globby'

export const inject = ['yakumo']

export function apply(ctx: Context) {
  ctx.register('mocha', async () => {
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

    const files = await globby(getFiles(ctx.yakumo.argv._), {
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
