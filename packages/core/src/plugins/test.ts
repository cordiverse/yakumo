import { spawn } from 'node:child_process'
import { Context } from 'cordis'
import { globby } from 'globby'
import { hyphenate } from 'cosmokit'

export const inject = ['yakumo', 'cli']

/** Convert options dict back to CLI args (replaces yargs-unparser) */
function unparseOptions(options: Record<string, any>): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(options)) {
    if (key === 'help' || key === 'h') continue
    const flag = `--${hyphenate(key)}`
    if (value === true) {
      args.push(flag)
    } else if (value === false) {
      args.push(`--no-${hyphenate(key)}`)
    } else if (Array.isArray(value)) {
      for (const v of value) {
        args.push(flag, String(v))
      }
    } else if (value !== undefined) {
      args.push(flag, String(value))
    }
  }
  return args
}

export function apply(ctx: Context) {
  ctx.cli
    .command('yakumo.test [...packages]', 'Run tests in packages')
    .action(async ({ args, options }) => {
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

      const child = spawn(process.execPath, [
        // Pass through unknown options to node --test
        ...unparseOptions(options as Record<string, any>),
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
