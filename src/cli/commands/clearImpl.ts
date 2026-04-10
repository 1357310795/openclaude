import { clearConversation } from '../../commands/clear/conversation.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async (_args, context) => {
  await clearConversation({
    setMessages: context.setMessages,
    readFileState: context.readFileState,
    discoveredSkillNames: context.discoveredSkillNames,
    loadedNestedMemoryPaths: context.loadedNestedMemoryPaths,
    getAppState: context.getAppState,
    setAppState: context.setAppState,
    setConversationId: context.setConversationId,
  })

  return {
    type: 'text',
    value: 'Conversation cleared.',
  }
}
