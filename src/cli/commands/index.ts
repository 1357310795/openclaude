import type { Command } from '../../commands.js'
import clear from './clear.js'

export type CliCommandProvider = 'feishu'

const CLI_COMMANDS_BY_PROVIDER: Record<CliCommandProvider, readonly Command[]> =
  {
    feishu: [clear],
  }

export function getCliCommands(
  provider: CliCommandProvider,
): readonly Command[] {
  return CLI_COMMANDS_BY_PROVIDER[provider]
}
