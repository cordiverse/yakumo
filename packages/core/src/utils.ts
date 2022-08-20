import ora from 'ora'
import prompts from 'prompts'
import which from 'which-pm-runs'
import { spawn, SpawnOptions } from 'child_process'

export async function confirm(message: string) {
  const { value } = await prompts({
    name: 'value',
    type: 'confirm',
    message,
  })
  return value as boolean
}

export function exit(message: string) {
  const spinner = ora()
  spinner.info(message)
  return process.exit(0)
}

export function spawnAsync(args: string[], options: SpawnOptions = {}) {
  const child = spawn(args[0], args.slice(1), { stdio: 'inherit', ...options })
  return new Promise<number>((resolve) => {
    child.stderr?.pipe(process.stderr)
    child.stdout?.pipe(process.stdout)
    child.on('close', resolve)
  })
}

export function exec(args: string[], options: SpawnOptions = {}) {
  const agent = which()
  const prefix = agent ? [agent.name, 'exec', '--'] : []
  return spawnAsync([...prefix, ...args], options)
}
