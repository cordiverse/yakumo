import { Arguments, commands, config, configRequire, Project, register, requireSafe } from '.'
import { red } from 'kleur'
import parse from 'yargs-parser'
import './plugins/prepare'

if (process.argv.length <= 2) {
  console.log('yakumo')
  process.exit(0)
}

const name = process.argv[2]

for (const filename of config.require) {
  configRequire(filename)
}

for (const name in config.pipeline) {
  register(name, async () => {
    const tasks = config.pipeline[name]
    for (const task of tasks) {
      const [name, ...args] = task.split(/\s+/g)
      await execute(name, ...args)
    }
  })
}

const project = new Project()

async function execute(name: string, ...args: string[]) {
  requireSafe('yakumo-' + name)
  if (!commands[name]) {
    console.error(red(`unknown command: ${name}`))
    process.exit(1)
  }

  const [callback, options] = commands[name]
  const argv = parse([...process.argv.slice(3), ...args], options) as Arguments
  argv.config = options
  await project.initialize(argv)
  return callback(project)
}

execute(name)
