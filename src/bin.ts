#!/usr/bin/env node

import registerBuildCommand from './build'
import registerBumpCommand from './bump'
import registerDepCommand from './dep'
import registerPublishCommand from './publish'
import CAC from 'cac'

const { version } = require('../package.json')

const cli = CAC('yakumo').help().version(version)

registerBuildCommand(cli)
registerBumpCommand(cli)
registerDepCommand(cli)
registerPublishCommand(cli)

cli.parse()

if (!cli.matchedCommand) {
  cli.outputHelp()
}
