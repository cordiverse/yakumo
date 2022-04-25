#!/usr/bin/env node

import { cwd, Project, hooks, requireSafe } from '.'

if (process.argv.length <= 2) {
  console.log('yakumo')
  process.exit(0)
}

const command = process.argv[2]

requireSafe(cwd + '/build/' + command)
requireSafe('yakumo-' + command)

;(async () => {
  const project = new Project(process.argv.slice(3))
  await project.initialize()
  if (!hooks['command/' + command]) {
    throw new Error(`unknown command: "${command}"`)
  }
  return project.emit('command/' + command, project)
})()
