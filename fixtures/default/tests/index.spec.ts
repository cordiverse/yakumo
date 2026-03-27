import { testExec } from '@yakumojs/test-utils'
import { describe } from 'node:test'

describe('basic', () => {
  // no args: shows help
  testExec({ args: [] })

  // unknown command: exit 1
  testExec({ args: ['foo'], code: 1 })

  // another unknown command
  testExec({ args: ['nonexistent'], code: 1 })
})

describe('help', () => {
  // --help flag
  testExec({ args: ['--help'] })

  // help command
  testExec({ args: ['help'] })

  // help for specific commands
  testExec({ args: ['help', 'build'] })
  testExec({ args: ['help', 'esbuild'] })
  testExec({ args: ['help', 'tsc'] })
  testExec({ args: ['help', 'mocha'] })
})

describe('version', () => {
  testExec({ args: ['-v'] })
  testExec({ args: ['--version'] })
})

describe('build', () => {
  testExec({ args: ['build'] })
})

describe('esbuild', () => {
  // build all packages
  testExec({ args: ['esbuild'] })

  // build specific package
  testExec({ args: ['esbuild', 'bar'] })

  // build with option
  testExec({ args: ['esbuild', '--minify'] })

  // unknown option: exit 1
  testExec({ args: ['esbuild', '--unknown'], code: 1 })
})

describe('tsc', () => {
  // clean build files
  testExec({ args: ['tsc', '--clean'] })

  // unknown option: exit 1
  testExec({ args: ['tsc', '--unknown'], code: 1 })
})
