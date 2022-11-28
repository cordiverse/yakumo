import { testExec } from '@yakumojs/test-utils'

describe('basic', () => {
  testExec({ args: [] })

  testExec({ args: ['foo'], code: 1 })
})

describe('build', () => {
  testExec({ args: ['build'], code: 0 })
})
