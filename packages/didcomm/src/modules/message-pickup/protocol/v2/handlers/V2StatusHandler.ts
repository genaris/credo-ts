import type { DidCommMessageHandler } from '../../../../../handlers'
import type { InboundDidCommMessageContext } from '../../../../../models'
import type { V2MessagePickupProtocol } from '../V2MessagePickupProtocol'

import { OutboundDidCommMessageContext } from '../../../../../models'
import { V2StatusMessage } from '../messages'

export class V2StatusHandler implements DidCommMessageHandler {
  public supportedMessages = [V2StatusMessage]
  private messagePickupProtocol: V2MessagePickupProtocol

  public constructor(messagePickupProtocol: V2MessagePickupProtocol) {
    this.messagePickupProtocol = messagePickupProtocol
  }

  public async handle(messageContext: InboundDidCommMessageContext<V2StatusMessage>) {
    const connection = messageContext.assertReadyConnection()
    const deliveryRequestMessage = await this.messagePickupProtocol.processStatus(messageContext)

    if (deliveryRequestMessage) {
      return new OutboundDidCommMessageContext(deliveryRequestMessage, {
        agentContext: messageContext.agentContext,
        connection,
      })
    }
  }
}
