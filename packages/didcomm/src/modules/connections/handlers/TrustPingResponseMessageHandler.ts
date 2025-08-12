import type { DidCommMessageHandler, DidCommMessageHandlerInboundMessage } from '../../../handlers'
import type { TrustPingService } from '../services'

import { TrustPingResponseMessage } from '../messages'

export class TrustPingResponseMessageHandler implements DidCommMessageHandler {
  private trustPingService: TrustPingService
  public supportedMessages = [TrustPingResponseMessage]

  public constructor(trustPingService: TrustPingService) {
    this.trustPingService = trustPingService
  }

  public async handle(inboundMessage: DidCommMessageHandlerInboundMessage<TrustPingResponseMessageHandler>) {
    await this.trustPingService.processPingResponse(inboundMessage)

    return undefined
  }
}
