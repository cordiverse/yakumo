import { spawn } from 'child_process'
import { Context } from '..'
import parse from 'yargs-parser'
import unparse from 'yargs-unparser'

export function apply(ctx: Context) {
  ctx.register('test', async () => {
    const argv = parse(process.argv.slice(3))
    if (argv._.length) {
      argv._ = argv._.flatMap((arg: string) => {
        const [folder] = arg.split('/', 1)
        const name = arg.slice(folder.length + 1) || '*'
        return ctx.yakumo.locate(folder, { includeRoot: true }).map((path) => {
          return `${path}/tests/${name}.spec.ts`.slice(1)
        })
      })
    } else {
      argv._ = ['**/tests/*.spec.ts']
    }

    const _ = argv._
    argv._ = []
    const child = spawn(process.execPath, [
      ...unparse(argv),
      '--test',
      ..._,
    ], {
      stdio: 'inherit',
      cwd: ctx.yakumo.cwd,
    })

    child.on('exit', (code, signal) => {
      process.on('exit', () => {
        if (signal) {
          process.kill(process.pid, signal)
        } else {
          process.exit(code)
        }
      })
    })

    process.on('SIGINT', () => {
      child.kill('SIGINT')
    })
  }, {
    manual: true,
  })
}
