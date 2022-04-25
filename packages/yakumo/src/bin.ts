#!/usr/bin/env node

import { cwd, commands, Project, requireSafe } from '.'
import parse from 'yargs-parser'

if (process.argv.length <= 2) {
  console.log('yakumo')
  process.exit(0)
}

const name = process.argv[2]

requireSafe(cwd + '/build/' + name)
requireSafe('yakumo-' + name)

if (!commands[name]) {
  throw new Error(`unknown command: "${name}"`)
}

;(async () => {
  const [callback, options] = commands[name]
  const argv = parse(process.argv.slice(3), options)
  const project = new Project(argv)
  await project.initialize()
  return callback(project)
})()
