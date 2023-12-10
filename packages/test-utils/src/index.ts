import { spawn } from 'child_process'
import { equal } from 'assert'
import { it as test } from 'node:test'
import path from 'path'

export interface TestExecOptions {
  args: string[]
  code?: number
}

export function testExec(options: TestExecOptions) {
  const command = options.args.join(' ')
  test(command, (t, done) => {
    const child = spawn(process.execPath, ['-r', 'esbuild-register', require.resolve('yakumo/src/cli'), ...options.args], {
      cwd: path.resolve(__dirname, '../../../fixtures/default'),
      stdio: 'inherit',
    })
    child.on('close', (code) => {
      equal(code, options.code ?? 0)
      done()
    })
  })
}
