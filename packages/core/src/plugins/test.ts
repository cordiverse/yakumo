import { spawn } from 'child_process'
import { Context } from '../index.js'
import parse from 'yargs-parser'
import unparse from 'yargs-unparser'
import globby from 'globby'

export default function apply(ctx: Context) {
  ctx.register('test', async () => {
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

    const argv = parse(process.argv.slice(3))
    const files = await globby(getFiles(argv._ as string[]), {
      cwd: ctx.yakumo.cwd,
      onlyFiles: true,
    })
    argv._ = []
    const child = spawn(process.execPath, [
      ...unparse(argv),
      '--test',
      ...files,
    ], {
      stdio: 'inherit',
      cwd: ctx.yakumo.cwd,
    })

    child.on('exit', (code, signal) => {
      process.on('exit', () => {
        if (signal) {
          process.kill(process.pid, signal)
        } else {
          process.exit(code ?? undefined)
        }
      })
    })

    process.on('SIGINT', () => {
      child.kill('SIGINT')
    })
  })
}
