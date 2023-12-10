import { testExec } from '@yakumojs/test-utils'
import { describe } from 'node:test'

describe('basic', () => {
  testExec({ args: [] })

  testExec({ args: ['foo'], code: 1 })
})

describe('build', () => {
  testExec({ args: ['build'], code: 0 })
})

describe('clean', () => {
  testExec({ args: ['tsc', '--clean'], code: 0 })
})
