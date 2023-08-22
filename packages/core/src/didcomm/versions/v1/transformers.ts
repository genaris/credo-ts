import type { DidCommV1Message } from './DidCommV1Message'

import { DidCommV2Message } from '../v2'

export function toDidCommV2(message: DidCommV1Message): DidCommV2Message {
  // Apply mapping from https://github.com/decentralized-identity/didcomm-book/blob/main/docs/migratorscript.md

  class MessageClass extends DidCommV2Message {
    public readonly type: string = message.type
  }

  const outputMessage = new MessageClass()
  outputMessage.id = message.id
  outputMessage.thid = message.thread?.threadId
  outputMessage.parentThreadId = message.thread?.parentThreadId

  return outputMessage
}
