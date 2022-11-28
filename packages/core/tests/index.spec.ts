import { execute } from '@yakumojs/test-utils'
import { expect } from 'chai'

describe('basic', () => {
  it('help', () => {
    const result = execute([])
    expect(result.status).to.equal(0)
    expect(result.stdout).to.equal('yakumo\n')
  })

  it('unknown', () => {
    const result = execute(['foo'])
    expect(result.status).to.equal(1)
    expect(result.stderr).to.equal('unknown command: foo\n')
  })
})
