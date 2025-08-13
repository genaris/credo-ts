import type { DidCommCredentialExchangeRecord, DidCommMessageHandler, DidCommMessageHandlerInboundMessage } from '@credo-ts/didcomm'
import type { V1CredentialProtocol } from '../V1DidCommCredentialProtocol'

import { CredoError } from '@credo-ts/core'
import { getOutboundDidCommMessageContext } from '@credo-ts/didcomm'

import { V1RequestCredentialMessage } from '../messages'

export class V1RequestCredentialHandler implements DidCommMessageHandler {
  private credentialProtocol: V1CredentialProtocol
  public supportedMessages = [V1RequestCredentialMessage]

  public constructor(credentialProtocol: V1CredentialProtocol) {
    this.credentialProtocol = credentialProtocol
  }

  public async handle(messageContext: DidCommMessageHandlerInboundMessage<V1RequestCredentialHandler>) {
    const credentialExchangeRecord = await this.credentialProtocol.processRequest(messageContext)

    const shouldAutoRespond = await this.credentialProtocol.shouldAutoRespondToRequest(messageContext.agentContext, {
      credentialExchangeRecord,
      requestMessage: messageContext.message,
    })

    if (shouldAutoRespond) {
      return await this.acceptRequest(credentialExchangeRecord, messageContext)
    }
  }

  private async acceptRequest(
    credentialExchangeRecord: DidCommCredentialExchangeRecord,
    messageContext: DidCommMessageHandlerInboundMessage<V1RequestCredentialHandler>
  ) {
    messageContext.agentContext.config.logger.info('Automatically sending credential with autoAccept')

    const offerMessage = await this.credentialProtocol.findOfferMessage(
      messageContext.agentContext,
      credentialExchangeRecord.id
    )
    if (!offerMessage) {
      throw new CredoError(`Could not find offer message for credential record with id ${credentialExchangeRecord.id}`)
    }

    const { message } = await this.credentialProtocol.acceptRequest(messageContext.agentContext, {
      credentialExchangeRecord,
    })

    return getOutboundDidCommMessageContext(messageContext.agentContext, {
      connectionRecord: messageContext.connection,
      message,
      associatedRecord: credentialExchangeRecord,
      lastReceivedMessage: messageContext.message,
      lastSentMessage: offerMessage,
    })
  }
}
