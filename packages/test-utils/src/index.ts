import { spawnSync } from 'child_process'
import path from 'path'

export function execute(args: string[]) {
  return spawnSync('node', ['-r', 'esbuild-register', require.resolve('yakumo/src/bin'), ...args], {
    cwd: path.resolve(__dirname, '../../../fixtures/default'),
    encoding: 'utf8',
  })
}
