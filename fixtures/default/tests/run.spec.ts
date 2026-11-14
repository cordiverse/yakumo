import { describe } from 'vitest'
import { testExec } from '@yakumojs/test-utils'

describe('run', () => {
  testExec({ args: ['run', 'foo', '--', 'echo', 'ok'] })
  testExec({ args: ['run', 'foo'], code: 1 })
})
