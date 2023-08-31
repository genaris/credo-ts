import type { ConstructableDidCommMessage, PlaintextDidCommV2Message } from './'
import type { PlaintextMessage } from './types'
import type { PlaintextDidCommV1Message } from './versions/v1'
import type { AgentBaseMessage } from '../agent/AgentBaseMessage'

import { Exclude } from 'class-transformer'

import { AriesFrameworkError } from '../error'
import { JsonTransformer } from '../utils'

import { DidCommMessageVersion } from './types'
import { DidCommV1Message, isPlaintextMessageV1 } from './versions/v1'
import { isDidCommV2Message, type DidCommV2Message, isPlaintextMessageV2 } from './versions/v2'

/**
 * Cast the plain JSON object to specific instance of Message extended from AgentMessage
 
 * @param message: Plain text message
 * @param MessageClass: Message class that corresponds to the message type
 */
export function transformFromPlainText(
  message: PlaintextMessage,
  MessageClass: ConstructableDidCommMessage
): AgentBaseMessage {
  let plainText = message
  if (isPlaintextMessageV1(message) && MessageClass.didCommVersion() === DidCommMessageVersion.V2) {
    // Convert plaintext to V2
    plainText = {
      id: message['@id'],
      type: message['@type'],
      body: 
    } as PlaintextDidCommV2Message
  }
  if (isPlaintextMessageV2(message) && MessageClass.didCommVersion() === DidCommMessageVersion.V1) {
    // Convert plaintext to V1
  }

  return JsonTransformer.fromJSON(plainText, MessageClass)
}

/**
 * Transforms a DIDComm V2 to its equivalent counterpart for DIDComm V1, according to the mapping in
 * https://github.com/decentralized-identity/didcomm-book/blob/main/docs/migratorscript.md
 *
 *
 * @param message: DIDComm message in V2 format
 * @returns Equivalent message for DIDComm V1
 */
export function toV1Message(message: AgentBaseMessage): DidCommV1Message {
  if (!isDidCommV2Message(message))
    throw new AriesFrameworkError(
      `Cannot convert messages with DIDComm version ${message.didCommVersion}. Only ${DidCommMessageVersion.V2} is supported`
    )
  class TransformedMessage extends DidCommV1Message {
    public type: string

    @Exclude()
    public bodyAsJson: Record<string, unknown>

    public constructor(v2Message: DidCommV2Message) {
      super()

      const { id, type, threadId, parentThreadId, senderOrder, receivedOrders, attachments } = v2Message

      // Set main fields
      this.id = id
      this.type = type
      this.thread = { threadId, parentThreadId, senderOrder }
      // TODO: appended attachments

      // Copy reference to message in order to be able to append in toJSON() method
      this.bodyAsJson = v2Message.toJSON().body as Record<string, unknown>
    }

    public toJSON({
      useDidSovPrefixWhereAllowed,
    }: {
      useDidSovPrefixWhereAllowed?: boolean | undefined
    }): PlaintextDidCommV1Message {
      const jsonObject = super.toJSON({ useDidSovPrefixWhereAllowed })

      for (const [key, value] of Object.entries(this.bodyAsJson)) {
        jsonObject[key] = value
      }
      return jsonObject
    }
  }

  const v1Message = new TransformedMessage(message as DidCommV2Message)

  return v1Message
}
