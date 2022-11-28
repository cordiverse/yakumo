import { spawn } from 'child_process'
import { equal } from 'assert'
import path from 'path'

export interface TestExecOptions {
  args: string[]
  code?: number
}

export function testExec(options: TestExecOptions) {
  const command = options.args.join(' ')
  it(command, (done) => {
    const child = spawn('node', ['-r', 'esbuild-register', require.resolve('yakumo/src/bin'), ...options.args], {
      cwd: path.resolve(__dirname, '../../../fixtures/default'),
      stdio: 'inherit',
    })
    child.on('close', (code) => {
      equal(code, options.code ?? 0)
      done()
    })
  })
}
