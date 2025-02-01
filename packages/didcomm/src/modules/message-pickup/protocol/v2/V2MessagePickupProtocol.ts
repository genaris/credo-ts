import type { AgentMessage } from '../../../../AgentMessage'
import type { AgentMessageReceivedEvent } from '../../../../Events'
import type { FeatureRegistry } from '../../../../FeatureRegistry'
import type { MessageHandlerRegistry } from '../../../../MessageHandlerRegistry'
import type { InboundMessageContext } from '../../../../models'
import type { EncryptedMessage } from '../../../../types'
import type { MessagePickupCompletedEvent } from '../../MessagePickupEvents'
import type {
  DeliverMessagesProtocolOptions,
  DeliverMessagesProtocolReturnType,
  PickupMessagesProtocolOptions,
  PickupMessagesProtocolReturnType,
  SetLiveDeliveryModeProtocolOptions,
  SetLiveDeliveryModeProtocolReturnType,
} from '../MessagePickupProtocolOptions'
import type { AgentContext } from '@credo-ts/core'

import { EventEmitter, injectable, verkeyToDidKey } from '@credo-ts/core'

import { DidCommModuleConfig } from '../../../../DidCommModuleConfig'
import { AgentEventTypes } from '../../../../Events'
import { Attachment } from '../../../../decorators/attachment/Attachment'
import { ProblemReportError } from '../../../../errors'
import { OutboundMessageContext, Protocol } from '../../../../models'
import { RoutingProblemReportReason } from '../../../routing/error'
import { MessagePickupEventTypes } from '../../MessagePickupEvents'
import { MessagePickupModuleConfig } from '../../MessagePickupModuleConfig'
import { MessagePickupSessionRole } from '../../MessagePickupSession'
import { MessagePickupSessionService } from '../../services'
import { BaseMessagePickupProtocol } from '../BaseMessagePickupProtocol'

import {
  V2DeliveryRequestHandler,
  V2LiveDeliveryChangeHandler,
  V2MessageDeliveryHandler,
  V2MessagesReceivedHandler,
  V2StatusHandler,
  V2StatusRequestHandler,
} from './handlers'
import {
  V2MessageDeliveryMessage,
  V2StatusMessage,
  V2DeliveryRequestMessage,
  V2MessagesReceivedMessage,
  V2StatusRequestMessage,
  V2LiveDeliveryChangeMessage,
} from './messages'

@injectable()
export class V2MessagePickupProtocol extends BaseMessagePickupProtocol {
  /**
   * The version of the message pickup protocol this class supports
   */
  public readonly version = 'v2' as const

  /**
   * Registers the protocol implementation (handlers, feature registry) on the agent.
   */
  public register(messageHandlerRegistry: MessageHandlerRegistry, featureRegistry: FeatureRegistry): void {
    messageHandlerRegistry.registerMessageHandlers([
      new V2StatusRequestHandler(this),
      new V2DeliveryRequestHandler(this),
      new V2MessagesReceivedHandler(this),
      new V2StatusHandler(this),
      new V2MessageDeliveryHandler(this),
      new V2LiveDeliveryChangeHandler(this),
    ])

    featureRegistry.register(
      new Protocol({
        id: 'https://didcomm.org/messagepickup/2.0',
        roles: ['mediator', 'recipient'],
      })
    )
  }

  public async createPickupMessage(
    agentContext: AgentContext,
    options: PickupMessagesProtocolOptions
  ): Promise<PickupMessagesProtocolReturnType<AgentMessage>> {
    const { connectionRecord, recipientDid: recipientKey } = options
    connectionRecord.assertReady()

    const message = new V2StatusRequestMessage({
      recipientKey,
    })

    return { message }
  }

  public async createDeliveryMessage(
    agentContext: AgentContext,
    options: DeliverMessagesProtocolOptions
  ): Promise<DeliverMessagesProtocolReturnType<AgentMessage> | void> {
    const { connectionRecord, recipientKey, messages } = options
    connectionRecord.assertReady()

    const queueTransportMessageRepository =
      agentContext.dependencyManager.resolve(DidCommModuleConfig).queueTransportMessageRepository

    // Get available messages from queue, but don't delete them
    const messagesToDeliver =
      messages ??
      (await queueTransportMessageRepository.takeFromQueue({
        connectionId: connectionRecord.id,
        recipientDid: recipientKey,
        limit: 10, // TODO: Define as config parameter
      }))

    if (messagesToDeliver.length === 0) {
      return
    }

    const attachments = messagesToDeliver.map(
      (msg) =>
        new Attachment({
          id: msg.id,
          lastmodTime: msg.receivedAt,
          data: {
            json: msg.encryptedMessage,
          },
        })
    )

    return {
      message: new V2MessageDeliveryMessage({
        attachments,
      }),
    }
  }

  public async setLiveDeliveryMode(
    agentContext: AgentContext,
    options: SetLiveDeliveryModeProtocolOptions
  ): Promise<SetLiveDeliveryModeProtocolReturnType<AgentMessage>> {
    const { connectionRecord, liveDelivery } = options
    connectionRecord.assertReady()
    return {
      message: new V2LiveDeliveryChangeMessage({
        liveDelivery,
      }),
    }
  }

  public async processStatusRequest(messageContext: InboundMessageContext<V2StatusRequestMessage>) {
    const { agentContext, message } = messageContext

    // Assert ready connection
    const connection = messageContext.assertReadyConnection()
    const recipientKey = message.recipientKey

    const queueTransportMessageRepository =
      agentContext.dependencyManager.resolve(DidCommModuleConfig).queueTransportMessageRepository

    const statusMessage = new V2StatusMessage({
      threadId: messageContext.message.threadId,
      recipientKey,
      messageCount: await queueTransportMessageRepository.getAvailableMessageCount({
        connectionId: connection.id,
        recipientDid: recipientKey ? verkeyToDidKey(recipientKey) : undefined,
      }),
    })

    return new OutboundMessageContext(statusMessage, { agentContext, connection })
  }

  public async processDeliveryRequest(messageContext: InboundMessageContext<V2DeliveryRequestMessage>) {
    // Assert ready connection
    const connection = messageContext.assertReadyConnection()
    const recipientKey = messageContext.message.recipientKey

    const { agentContext, message } = messageContext

    const queueTransportMessageRepository =
      agentContext.dependencyManager.resolve(DidCommModuleConfig).queueTransportMessageRepository

    // Get available messages from queue, but don't delete them
    const messages = await queueTransportMessageRepository.takeFromQueue({
      connectionId: connection.id,
      recipientDid: recipientKey ? verkeyToDidKey(recipientKey) : undefined,
      limit: message.limit,
    })

    const attachments = messages.map(
      (msg) =>
        new Attachment({
          id: msg.id,
          lastmodTime: msg.receivedAt,
          data: {
            json: msg.encryptedMessage,
          },
        })
    )

    const outboundMessageContext =
      messages.length > 0
        ? new V2MessageDeliveryMessage({
            threadId: messageContext.message.threadId,
            recipientKey,
            attachments,
          })
        : new V2StatusMessage({
            threadId: messageContext.message.threadId,
            recipientKey,
            messageCount: 0,
          })

    return new OutboundMessageContext(outboundMessageContext, { agentContext, connection })
  }

  public async processMessagesReceived(messageContext: InboundMessageContext<V2MessagesReceivedMessage>) {
    // Assert ready connection
    const connection = messageContext.assertReadyConnection()

    const { agentContext, message } = messageContext

    const queueTransportMessageRepository =
      agentContext.dependencyManager.resolve(DidCommModuleConfig).queueTransportMessageRepository

    if (message.messageIdList.length) {
      await queueTransportMessageRepository.removeMessages({
        connectionId: connection.id,
        messageIds: message.messageIdList,
      })
    }

    const statusMessage = new V2StatusMessage({
      threadId: messageContext.message.threadId,
      messageCount: await queueTransportMessageRepository.getAvailableMessageCount({ connectionId: connection.id }),
    })

    return new OutboundMessageContext(statusMessage, {
      agentContext: messageContext.agentContext,
      connection,
    })
  }

  public async processStatus(messageContext: InboundMessageContext<V2StatusMessage>) {
    const { agentContext, message: statusMessage } = messageContext
    const { messageCount, recipientKey } = statusMessage

    const connection = messageContext.assertReadyConnection()

    const messagePickupModuleConfig = agentContext.dependencyManager.resolve(MessagePickupModuleConfig)

    const eventEmitter = agentContext.dependencyManager.resolve(EventEmitter)

    //No messages to be retrieved: message pick-up is completed
    if (messageCount === 0) {
      eventEmitter.emit<MessagePickupCompletedEvent>(agentContext, {
        type: MessagePickupEventTypes.MessagePickupCompleted,
        payload: {
          connection,
          threadId: statusMessage.threadId,
        },
      })
      return null
    }

    const { maximumBatchSize: maximumMessagePickup } = messagePickupModuleConfig
    const limit = messageCount < maximumMessagePickup ? messageCount : maximumMessagePickup

    const deliveryRequestMessage = new V2DeliveryRequestMessage({
      limit,
      recipientKey,
    })

    return deliveryRequestMessage
  }

  public async processLiveDeliveryChange(messageContext: InboundMessageContext<V2LiveDeliveryChangeMessage>) {
    const { agentContext, message } = messageContext

    const connection = messageContext.assertReadyConnection()

    const queueTransportMessageRepository =
      agentContext.dependencyManager.resolve(DidCommModuleConfig).queueTransportMessageRepository

    const sessionService = agentContext.dependencyManager.resolve(MessagePickupSessionService)

    if (message.liveDelivery) {
      sessionService.saveLiveSession(agentContext, {
        connectionId: connection.id,
        protocolVersion: 'v2',
        role: MessagePickupSessionRole.MessageHolder,
      })
    } else {
      sessionService.removeLiveSession(agentContext, { connectionId: connection.id })
    }

    const statusMessage = new V2StatusMessage({
      threadId: message.threadId,
      liveDelivery: message.liveDelivery,
      messageCount: await queueTransportMessageRepository.getAvailableMessageCount({ connectionId: connection.id }),
    })

    return new OutboundMessageContext(statusMessage, { agentContext, connection })
  }

  public async processDelivery(messageContext: InboundMessageContext<V2MessageDeliveryMessage>) {
    messageContext.assertReadyConnection()

    const { appendedAttachments } = messageContext.message

    const eventEmitter = messageContext.agentContext.dependencyManager.resolve(EventEmitter)

    if (!appendedAttachments)
      throw new ProblemReportError('Error processing attachments', {
        problemCode: RoutingProblemReportReason.ErrorProcessingAttachments,
      })

    const ids: string[] = []
    for (const attachment of appendedAttachments) {
      ids.push(attachment.id)

      eventEmitter.emit<AgentMessageReceivedEvent>(messageContext.agentContext, {
        type: AgentEventTypes.AgentMessageReceived,
        payload: {
          message: attachment.getDataAsJson<EncryptedMessage>(),
          contextCorrelationId: messageContext.agentContext.contextCorrelationId,
          receivedAt: attachment.lastmodTime,
        },
      })
    }

    return new V2MessagesReceivedMessage({
      messageIdList: ids,
    })
  }
}
