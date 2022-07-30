#!/usr/bin/env node

import { commands, config, Project, requireSafe, Arguments } from '.'
import parse from 'yargs-parser'

if (process.argv.length <= 2) {
  console.log('yakumo')
  process.exit(0)
}

const name = process.argv[2]

for (const filename of config.require) {
  requireSafe(filename)
}

requireSafe('yakumo-' + name)

if (!commands[name]) {
  throw new Error(`unknown command: "${name}"`)
}

;(async () => {
  const [callback, options] = commands[name]
  const argv = parse(process.argv.slice(3), options) as Arguments
  argv.config = options
  const project = new Project(argv)
  await project.initialize()
  return callback(project)
})()
