#!/usr/bin/env node

import { cwd, Project } from '.'

if (process.argv.length <= 2) {
  console.log('yakumo')
  process.exit(0)
}

const command = process.argv[2]

try {
  require(cwd + '/scripts/' + command)
  require('yakumo-' + command)
} catch {}

(async () => {
  const project = new Project(process.argv.slice(3))
  await project.initialize()
  return project.emit(command)
})()
