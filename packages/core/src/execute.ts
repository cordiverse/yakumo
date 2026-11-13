import { execFile, ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Characters that cmd.exe interprets in a command line, escaped with `^`.
// The escaping follows cross-spawn, see https://qntm.org/cmd.
const metaChars = /([()\][%!^"`<>&|;, *?])/g

function quote(arg: string) {
  // The target parses its command line with the rules of the C runtime,
  // under which backslashes before a quote are doubled.
  arg = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  return arg.replace(metaChars, '^$1')
}

/**
 * Run a command and resolve with its output.
 *
 * On Windows, a command other than an `.exe` or `.com` file runs through cmd.exe.
 * A package manager or Corepack is a batch file (`.cmd`), which Node.js starts only
 * through cmd.exe, and cmd.exe completes a path without an extension, such as the
 * `npm_execpath` that Yarn exposes to lifecycle scripts.
 */
export function execute(command: string[], options: ExecFileOptions = {}) {
  let [file, ...args] = command
  if (process.platform === 'win32' && !/\.(?:exe|com)$/i.test(file)) {
    args = ['/d', '/s', '/c', `"${[file.replace(metaChars, '^$1'), ...args.map(quote)].join(' ')}"`]
    file = process.env.ComSpec || 'cmd.exe'
    options = { ...options, windowsVerbatimArguments: true }
  }
  return execFileAsync(file, args, { ...options, encoding: 'utf8' })
}
