import type { Command } from '../../commands.js'

const clear = {
  type: 'local',
  name: 'clear',
  description: 'Clear conversation history and start a fresh session',
  aliases: ['reset', 'new'],
  supportsNonInteractive: true,
  load: () => import('./clearImpl.js'),
} satisfies Command

export default clear
