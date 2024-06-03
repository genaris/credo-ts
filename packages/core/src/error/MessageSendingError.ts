import type { OutboundMessageContext } from '../agent/models'

import { CredoError } from './CredoError'

export enum MessageSendingErrorReason {
  MissingDid = 'MissingDid',
  NoConnection = 'NoConnection',
  UnableToResolveDidDocument = 'UnableToResolveDidDocument',
  UnableToRetrieveServices = 'UnableToRetrieveServices',
  Undeliverable = 'Undeliverable',
}

export class MessageSendingError extends CredoError {
  public outboundMessageContext: OutboundMessageContext
  public reason: MessageSendingErrorReason
  public constructor(
    message: string,
    {
      outboundMessageContext,
      reason,
      cause,
    }: { outboundMessageContext: OutboundMessageContext; reason: MessageSendingErrorReason; cause?: Error }
  ) {
    super(message, { cause })
    this.outboundMessageContext = outboundMessageContext
    this.reason = reason
  }
}
