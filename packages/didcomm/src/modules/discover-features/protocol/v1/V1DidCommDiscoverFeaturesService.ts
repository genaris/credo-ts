import type { DidCommMessage } from '../../../../DidCommMessage'
import type { InboundDidCommMessageContext } from '../../../../models'
import type {
  DidCommDiscoverFeaturesDisclosureReceivedEvent,
  DidCommDiscoverFeaturesQueryReceivedEvent,
} from '../../DidCommDiscoverFeaturesEvents'
import type {
  CreateDisclosureOptions,
  CreateQueryOptions,
  DiscoverFeaturesProtocolMsgReturnType,
} from '../../DidCommDiscoverFeaturesServiceOptions'

import { CredoError, EventEmitter, InjectionSymbols, Logger, inject, injectable } from '@credo-ts/core'

import { DidCommFeatureRegistry } from '../../../../DidCommFeatureRegistry'
import { DidCommMessageHandlerRegistry } from '../../../../DidCommMessageHandlerRegistry'
import { DidCommProtocol } from '../../../../models'
import { DidCommDiscoverFeaturesEventTypes } from '../../DidCommDiscoverFeaturesEvents'
import { DidCommDiscoverFeaturesModuleConfig } from '../../DidCommDiscoverFeaturesModuleConfig'
import { DidCommDiscoverFeaturesService } from '../../services'

import { V1DiscloseMessageHandler, V1QueryMessageHandler } from './handlers'
import { DiscloseProtocol, V1DiscloseMessage, V1QueryMessage } from './messages'

@injectable()
export class V1DidCommDiscoverFeaturesService extends DidCommDiscoverFeaturesService {
  public constructor(
    featureRegistry: DidCommFeatureRegistry,
    eventEmitter: EventEmitter,
    messageHandlerRegistry: DidCommMessageHandlerRegistry,
    @inject(InjectionSymbols.Logger) logger: Logger,
    discoverFeaturesConfig: DidCommDiscoverFeaturesModuleConfig
  ) {
    super(featureRegistry, eventEmitter, logger, discoverFeaturesConfig)

    this.registerMessageHandlers(messageHandlerRegistry)
  }

  /**
   * The version of the discover features protocol this service supports
   */
  public readonly version = 'v1'

  private registerMessageHandlers(messageHandlerRegistry: DidCommMessageHandlerRegistry) {
    messageHandlerRegistry.registerMessageHandler(new V1DiscloseMessageHandler(this))
    messageHandlerRegistry.registerMessageHandler(new V1QueryMessageHandler(this))
  }

  public async createQuery(
    options: CreateQueryOptions
  ): Promise<DiscoverFeaturesProtocolMsgReturnType<V1QueryMessage>> {
    if (options.queries.length > 1) {
      throw new CredoError('Discover Features V1 only supports a single query')
    }

    if (options.queries[0].featureType !== 'protocol') {
      throw new CredoError('Discover Features V1 only supports querying for protocol support')
    }

    const queryMessage = new V1QueryMessage({
      query: options.queries[0].match,
      comment: options.comment,
    })

    return { message: queryMessage }
  }

  public async processQuery(
    messageContext: InboundDidCommMessageContext<V1QueryMessage>
  ): Promise<DiscoverFeaturesProtocolMsgReturnType<DidCommMessage> | undefined> {
    const { query, threadId } = messageContext.message

    const connection = messageContext.assertReadyConnection()

    this.eventEmitter.emit<DidCommDiscoverFeaturesQueryReceivedEvent>(messageContext.agentContext, {
      type: DidCommDiscoverFeaturesEventTypes.QueryReceived,
      payload: {
        message: messageContext.message,
        connection,
        queries: [{ featureType: 'protocol', match: query }],
        protocolVersion: this.version,
        threadId,
      },
    })

    // Process query and send responde automatically if configured to do so, otherwise
    // just send the event and let controller decide
    if (this.discoverFeaturesModuleConfig.autoAcceptQueries) {
      return await this.createDisclosure({
        threadId,
        disclosureQueries: [{ featureType: 'protocol', match: query }],
      })
    }
  }

  public async createDisclosure(
    options: CreateDisclosureOptions
  ): Promise<DiscoverFeaturesProtocolMsgReturnType<V1DiscloseMessage>> {
    if (options.disclosureQueries.some((item) => item.featureType !== 'protocol')) {
      throw new CredoError('Discover Features V1 only supports protocols')
    }

    if (!options.threadId) {
      throw new CredoError('Thread Id is required for Discover Features V1 disclosure')
    }

    const matches = this.featureRegistry.query(...options.disclosureQueries)

    const discloseMessage = new V1DiscloseMessage({
      threadId: options.threadId,
      protocols: matches.map(
        (item) =>
          new DiscloseProtocol({
            protocolId: (item as DidCommProtocol).id,
            roles: (item as DidCommProtocol).roles,
          })
      ),
    })

    return { message: discloseMessage }
  }

  public async processDisclosure(messageContext: InboundDidCommMessageContext<V1DiscloseMessage>): Promise<void> {
    const { protocols, threadId } = messageContext.message

    const connection = messageContext.assertReadyConnection()

    this.eventEmitter.emit<DidCommDiscoverFeaturesDisclosureReceivedEvent>(messageContext.agentContext, {
      type: DidCommDiscoverFeaturesEventTypes.DisclosureReceived,
      payload: {
        message: messageContext.message,
        connection,
        disclosures: protocols.map((item) => new DidCommProtocol({ id: item.protocolId, roles: item.roles })),
        protocolVersion: this.version,
        threadId,
      },
    })
  }
}
