import type { AgentContext } from '@credo-ts/core'
import type { DidCommMessage } from '../../../../DidCommMessage'
import type { DidCommFeatureRegistry } from '../../../../DidCommFeatureRegistry'
import type { DidCommMessageHandlerRegistry } from '../../../../DidCommMessageHandlerRegistry'
import type { DidCommMessageHandlerInboundMessage } from '../../../../handlers'
import type { ProblemReportMessage } from '../../../../messages'
import type { InboundDidCommMessageContext } from '../../../../models'
import type {
  CredentialFormat,
  CredentialFormatPayload,
  CredentialFormatService,
  ExtractCredentialFormats,
} from '../../formats'
import type { DidCommCredentialFormatSpec } from '../../models/DidCommCredentialFormatSpec'
import type { DidCommCredentialProtocol } from '../DidCommCredentialProtocol'
import type {
  AcceptCredentialOfferOptions,
  AcceptCredentialOptions,
  AcceptCredentialProposalOptions,
  AcceptCredentialRequestOptions,
  CreateCredentialOfferOptions,
  CreateCredentialProblemReportOptions,
  CreateCredentialProposalOptions,
  CreateCredentialRequestOptions,
  CredentialFormatDataMessagePayload,
  CredentialProtocolMsgReturnType,
  GetCredentialFormatDataReturn,
  NegotiateCredentialOfferOptions,
  NegotiateCredentialProposalOptions,
} from '../DidCommCredentialProtocolOptions'

import { CredoError, utils } from '@credo-ts/core'

import { AckStatus } from '../../../../messages'
import { DidCommProtocol } from '../../../../models'
import { DidCommMessageRepository, DidCommMessageRole } from '../../../../repository'
import { DidCommConnectionService } from '../../../connections'
import { DidCommCredentialsModuleConfig } from '../../DidCommCredentialsModuleConfig'
import { DidCommAutoAcceptCredential, DidCommCredentialProblemReportReason, DidCommCredentialRole, DidCommCredentialState } from '../../models'
import { DidCommCredentialExchangeRecord, DidCommCredentialExchangeRepository } from '../../repository'
import { composeAutoAccept } from '../../util/composeAutoAccept'
import { arePreviewAttributesEqual } from '../../util/previewAttributes'
import { BaseDidCommCredentialProtocol } from '../BaseDidCommCredentialProtocol'

import { CredentialFormatCoordinator } from './CredentialFormatCoordinator'
import {
  V2CredentialAckHandler,
  V2IssueCredentialHandler,
  V2OfferCredentialHandler,
  V2ProposeCredentialHandler,
  V2RequestCredentialHandler,
} from './handlers'
import { V2CredentialProblemReportHandler } from './handlers/V2CredentialProblemReportHandler'
import {
  V2CredentialAckMessage,
  V2CredentialProblemReportMessage,
  V2IssueCredentialMessage,
  V2OfferCredentialMessage,
  V2ProposeCredentialMessage,
  V2RequestCredentialMessage,
} from './messages'

export interface V2DidCommCredentialProtocolConfig<CredentialFormatServices extends CredentialFormatService[]> {
  credentialFormats: CredentialFormatServices
}

export class V2DidCommCredentialProtocol<CFs extends CredentialFormatService[] = CredentialFormatService[]>
  extends BaseDidCommCredentialProtocol<CFs>
  implements DidCommCredentialProtocol<CFs>
{
  private credentialFormatCoordinator = new CredentialFormatCoordinator<CFs>()
  private credentialFormats: CFs

  public constructor({ credentialFormats }: V2DidCommCredentialProtocolConfig<CFs>) {
    super()

    this.credentialFormats = credentialFormats
  }

  /**
   * The version of the issue credential protocol this service supports
   */
  public readonly version = 'v2' as const

  /**
   * Registers the protocol implementation (handlers, feature registry) on the agent.
   */
  public register(messageHandlerRegistry: DidCommMessageHandlerRegistry, featureRegistry: DidCommFeatureRegistry) {
    // Register message handlers for the Issue Credential V2 Protocol
    messageHandlerRegistry.registerMessageHandlers([
      new V2ProposeCredentialHandler(this),
      new V2OfferCredentialHandler(this),
      new V2RequestCredentialHandler(this),
      new V2IssueCredentialHandler(this),
      new V2CredentialAckHandler(this),
      new V2CredentialProblemReportHandler(this),
    ])

    // Register Issue Credential V2 in feature registry, with supported roles
    featureRegistry.register(
      new DidCommProtocol({
        id: 'https://didcomm.org/issue-credential/2.0',
        roles: ['holder', 'issuer'],
      })
    )
  }

  /**
   * Create a {@link V2ProposeCredentialMessage} not bound to an existing credential exchange.
   *
   * @param proposal The ProposeCredentialOptions object containing the important fields for the credential message
   * @returns Object containing proposal message and associated credential record
   *
   */
  public async createProposal(
    agentContext: AgentContext,
    {
      connectionRecord,
      credentialFormats,
      comment,
      goal,
      goalCode,
      autoAcceptCredential,
    }: CreateCredentialProposalOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<DidCommMessage>> {
    agentContext.config.logger.debug('Get the Format Service and Create Proposal Message')

    const credentialRepository = agentContext.dependencyManager.resolve(DidCommCredentialExchangeRepository)

    const formatServices = this.getFormatServices(credentialFormats)
    if (formatServices.length === 0) {
      throw new CredoError('Unable to create proposal. No supported formats')
    }

    const credentialExchangeRecord = new DidCommCredentialExchangeRecord({
      connectionId: connectionRecord.id,
      threadId: utils.uuid(),
      state: DidCommCredentialState.ProposalSent,
      role: DidCommCredentialRole.Holder,
      autoAcceptCredential,
      protocolVersion: 'v2',
    })

    const proposalMessage = await this.credentialFormatCoordinator.createProposal(agentContext, {
      credentialFormats,
      credentialExchangeRecord,
      formatServices,
      comment,
      goal,
      goalCode,
    })

    agentContext.config.logger.debug('Save record and emit state change event')
    await credentialRepository.save(agentContext, credentialExchangeRecord)
    this.emitStateChangedEvent(agentContext, credentialExchangeRecord, null)

    return { credentialExchangeRecord, message: proposalMessage }
  }

  /**
   * Method called by {@link V2ProposeCredentialHandler} on reception of a propose credential message
   * We do the necessary processing here to accept the proposal and do the state change, emit event etc.
   * @param messageContext the inbound propose credential message
   * @returns credential record appropriate for this incoming message (once accepted)
   */
  public async processProposal(
    messageContext: InboundDidCommMessageContext<V2ProposeCredentialMessage>
  ): Promise<DidCommCredentialExchangeRecord> {
    const { message: proposalMessage, connection, agentContext } = messageContext

    agentContext.config.logger.debug(`Processing credential proposal with id ${proposalMessage.id}`)

    const credentialRepository = agentContext.dependencyManager.resolve(DidCommCredentialExchangeRepository)
    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)
    const connectionService = agentContext.dependencyManager.resolve(DidCommConnectionService)

    let credentialExchangeRecord = await this.findByProperties(messageContext.agentContext, {
      threadId: proposalMessage.threadId,
      role: DidCommCredentialRole.Issuer,
    })

    const formatServices = this.getFormatServicesFromMessage(proposalMessage.formats)
    if (formatServices.length === 0) {
      throw new CredoError('Unable to process proposal. No supported formats')
    }

    // credential record already exists
    if (credentialExchangeRecord) {
      const proposalCredentialMessage = await didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
        associatedRecordId: credentialExchangeRecord.id,
        messageClass: V2ProposeCredentialMessage,
        role: DidCommMessageRole.Receiver,
      })
      const offerCredentialMessage = await didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
        associatedRecordId: credentialExchangeRecord.id,
        messageClass: V2OfferCredentialMessage,
        role: DidCommMessageRole.Sender,
      })

      // Assert
      credentialExchangeRecord.assertProtocolVersion('v2')
      credentialExchangeRecord.assertState(DidCommCredentialState.OfferSent)
      await connectionService.assertConnectionOrOutOfBandExchange(messageContext, {
        lastReceivedMessage: proposalCredentialMessage ?? undefined,
        lastSentMessage: offerCredentialMessage ?? undefined,
        expectedConnectionId: credentialExchangeRecord.connectionId,
      })

      // This makes sure that the sender of the incoming message is authorized to do so.
      if (!credentialExchangeRecord?.connectionId) {
        await connectionService.matchIncomingMessageToRequestMessageInOutOfBandExchange(messageContext, {
          expectedConnectionId: credentialExchangeRecord?.connectionId,
        })

        credentialExchangeRecord.connectionId = connection?.id
      }

      await this.credentialFormatCoordinator.processProposal(messageContext.agentContext, {
        credentialExchangeRecord,
        formatServices,
        message: proposalMessage,
      })

      await this.updateState(messageContext.agentContext, credentialExchangeRecord, DidCommCredentialState.ProposalReceived)

      return credentialExchangeRecord
    }
    // Assert
    await connectionService.assertConnectionOrOutOfBandExchange(messageContext)

    // No credential record exists with thread id
    credentialExchangeRecord = new DidCommCredentialExchangeRecord({
      connectionId: connection?.id,
      threadId: proposalMessage.threadId,
      parentThreadId: proposalMessage.thread?.parentThreadId,
      state: DidCommCredentialState.ProposalReceived,
      role: DidCommCredentialRole.Issuer,
      protocolVersion: 'v2',
    })

    await this.credentialFormatCoordinator.processProposal(messageContext.agentContext, {
      credentialExchangeRecord,
      formatServices,
      message: proposalMessage,
    })

    // Save record and emit event
    await credentialRepository.save(messageContext.agentContext, credentialExchangeRecord)
    this.emitStateChangedEvent(messageContext.agentContext, credentialExchangeRecord, null)

    return credentialExchangeRecord
  }

  public async acceptProposal(
    agentContext: AgentContext,
    {
      credentialExchangeRecord,
      credentialFormats,
      autoAcceptCredential,
      comment,
      goal,
      goalCode,
    }: AcceptCredentialProposalOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<V2OfferCredentialMessage>> {
    // Assert
    credentialExchangeRecord.assertProtocolVersion('v2')
    credentialExchangeRecord.assertState(DidCommCredentialState.ProposalReceived)

    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)

    // Use empty credentialFormats if not provided to denote all formats should be accepted
    let formatServices = this.getFormatServices(credentialFormats ?? {})

    // if no format services could be extracted from the credentialFormats
    // take all available format services from the proposal message
    if (formatServices.length === 0) {
      const proposalMessage = await didCommMessageRepository.getAgentMessage(agentContext, {
        associatedRecordId: credentialExchangeRecord.id,
        messageClass: V2ProposeCredentialMessage,
        role: DidCommMessageRole.Receiver,
      })

      formatServices = this.getFormatServicesFromMessage(proposalMessage.formats)
    }

    // If the format services list is still empty, throw an error as we don't support any
    // of the formats
    if (formatServices.length === 0) {
      throw new CredoError('Unable to accept proposal. No supported formats provided as input or in proposal message')
    }

    const offerMessage = await this.credentialFormatCoordinator.acceptProposal(agentContext, {
      credentialExchangeRecord,
      formatServices,
      comment,
      goal,
      goalCode,
      credentialFormats,
    })

    credentialExchangeRecord.autoAcceptCredential = autoAcceptCredential ?? credentialExchangeRecord.autoAcceptCredential
    await this.updateState(agentContext, credentialExchangeRecord, DidCommCredentialState.OfferSent)

    return { credentialExchangeRecord, message: offerMessage }
  }

  /**
   * Negotiate a credential proposal as issuer (by sending a credential offer message) to the connection
   * associated with the credential record.
   *
   * @param options configuration for the offer see {@link NegotiateCredentialProposalOptions}
   * @returns Credential exchange record associated with the credential offer
   *
   */
  public async negotiateProposal(
    agentContext: AgentContext,
    {
      credentialExchangeRecord,
      credentialFormats,
      autoAcceptCredential,
      comment,
      goal,
      goalCode,
    }: NegotiateCredentialProposalOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<V2OfferCredentialMessage>> {
    // Assert
    credentialExchangeRecord.assertProtocolVersion('v2')
    credentialExchangeRecord.assertState(DidCommCredentialState.ProposalReceived)

    if (!credentialExchangeRecord.connectionId) {
      throw new CredoError(
        `No connectionId found for credential record '${credentialExchangeRecord.id}'. Connection-less issuance does not support negotiation.`
      )
    }

    const formatServices = this.getFormatServices(credentialFormats)
    if (formatServices.length === 0) {
      throw new CredoError('Unable to create offer. No supported formats')
    }

    const offerMessage = await this.credentialFormatCoordinator.createOffer(agentContext, {
      formatServices,
      credentialFormats,
      credentialExchangeRecord,
      comment,
      goal,
      goalCode,
    })

    credentialExchangeRecord.autoAcceptCredential = autoAcceptCredential ?? credentialExchangeRecord.autoAcceptCredential
    await this.updateState(agentContext, credentialExchangeRecord, DidCommCredentialState.OfferSent)

    return { credentialExchangeRecord, message: offerMessage }
  }

  /**
   * Create a {@link V2OfferCredentialMessage} as beginning of protocol process. If no connectionId is provided, the
   * exchange will be created without a connection for usage in oob and connection-less issuance.
   *
   * @param formatService {@link CredentialFormatService} the format service object containing format-specific logic
   * @param options attributes of the original offer
   * @returns Object containing offer message and associated credential record
   *
   */
  public async createOffer(
    agentContext: AgentContext,
    {
      credentialFormats,
      autoAcceptCredential,
      comment,
      goal,
      goalCode,
      connectionRecord,
    }: CreateCredentialOfferOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<V2OfferCredentialMessage>> {
    const credentialRepository = agentContext.dependencyManager.resolve(DidCommCredentialExchangeRepository)

    const formatServices = this.getFormatServices(credentialFormats)
    if (formatServices.length === 0) {
      throw new CredoError('Unable to create offer. No supported formats')
    }

    const credentialExchangeRecord = new DidCommCredentialExchangeRecord({
      connectionId: connectionRecord?.id,
      threadId: utils.uuid(),
      state: DidCommCredentialState.OfferSent,
      role: DidCommCredentialRole.Issuer,
      autoAcceptCredential,
      protocolVersion: 'v2',
    })

    const offerMessage = await this.credentialFormatCoordinator.createOffer(agentContext, {
      formatServices,
      credentialFormats,
      credentialExchangeRecord,
      comment,
      goal,
      goalCode,
    })

    agentContext.config.logger.debug(
      `Saving record and emitting state changed for credential exchange record ${credentialExchangeRecord.id}`
    )
    await credentialRepository.save(agentContext, credentialExchangeRecord)
    this.emitStateChangedEvent(agentContext, credentialExchangeRecord, null)

    return { credentialExchangeRecord, message: offerMessage }
  }

  /**
   * Method called by {@link V2OfferCredentialHandler} on reception of a offer credential message
   * We do the necessary processing here to accept the offer and do the state change, emit event etc.
   * @param messageContext the inbound offer credential message
   * @returns credential record appropriate for this incoming message (once accepted)
   */
  public async processOffer(
    messageContext: DidCommMessageHandlerInboundMessage<V2OfferCredentialHandler>
  ): Promise<DidCommCredentialExchangeRecord> {
    const { message: offerMessage, connection, agentContext } = messageContext

    agentContext.config.logger.debug(`Processing credential offer with id ${offerMessage.id}`)

    const credentialRepository = agentContext.dependencyManager.resolve(DidCommCredentialExchangeRepository)
    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)
    const connectionService = agentContext.dependencyManager.resolve(DidCommConnectionService)

    let credentialExchangeRecord = await this.findByProperties(messageContext.agentContext, {
      threadId: offerMessage.threadId,
      role: DidCommCredentialRole.Holder,
      connectionId: connection?.id,
    })

    const formatServices = this.getFormatServicesFromMessage(offerMessage.formats)
    if (formatServices.length === 0) {
      throw new CredoError('Unable to process offer. No supported formats')
    }

    // credential record already exists
    if (credentialExchangeRecord) {
      const proposeCredentialMessage = await didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
        associatedRecordId: credentialExchangeRecord.id,
        messageClass: V2ProposeCredentialMessage,
        role: DidCommMessageRole.Sender,
      })
      const offerCredentialMessage = await didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
        associatedRecordId: credentialExchangeRecord.id,
        messageClass: V2OfferCredentialMessage,
        role: DidCommMessageRole.Receiver,
      })

      credentialExchangeRecord.assertProtocolVersion('v2')
      credentialExchangeRecord.assertState(DidCommCredentialState.ProposalSent)
      await connectionService.assertConnectionOrOutOfBandExchange(messageContext, {
        lastReceivedMessage: offerCredentialMessage ?? undefined,
        lastSentMessage: proposeCredentialMessage ?? undefined,
        expectedConnectionId: credentialExchangeRecord.connectionId,
      })

      await this.credentialFormatCoordinator.processOffer(messageContext.agentContext, {
        credentialExchangeRecord,
        formatServices,
        message: offerMessage,
      })

      await this.updateState(messageContext.agentContext, credentialExchangeRecord, DidCommCredentialState.OfferReceived)
      return credentialExchangeRecord
    }
    // Assert
    await connectionService.assertConnectionOrOutOfBandExchange(messageContext)

    // No credential record exists with thread id
    agentContext.config.logger.debug('No credential record found for offer, creating a new one')
    credentialExchangeRecord = new DidCommCredentialExchangeRecord({
      connectionId: connection?.id,
      threadId: offerMessage.threadId,
      parentThreadId: offerMessage.thread?.parentThreadId,
      state: DidCommCredentialState.OfferReceived,
      role: DidCommCredentialRole.Holder,
      protocolVersion: 'v2',
    })

    await this.credentialFormatCoordinator.processOffer(messageContext.agentContext, {
      credentialExchangeRecord,
      formatServices,
      message: offerMessage,
    })

    // Save in repository
    agentContext.config.logger.debug('Saving credential record and emit offer-received event')
    await credentialRepository.save(messageContext.agentContext, credentialExchangeRecord)

    this.emitStateChangedEvent(messageContext.agentContext, credentialExchangeRecord, null)
    return credentialExchangeRecord
  }

  public async acceptOffer(
    agentContext: AgentContext,
    {
      credentialExchangeRecord,
      autoAcceptCredential,
      comment,
      goal,
      goalCode,
      credentialFormats,
    }: AcceptCredentialOfferOptions<CFs>
  ) {
    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)

    // Assert
    credentialExchangeRecord.assertProtocolVersion('v2')
    credentialExchangeRecord.assertState(DidCommCredentialState.OfferReceived)

    // Use empty credentialFormats if not provided to denote all formats should be accepted
    let formatServices = this.getFormatServices(credentialFormats ?? {})

    // if no format services could be extracted from the credentialFormats
    // take all available format services from the offer message
    if (formatServices.length === 0) {
      const offerMessage = await didCommMessageRepository.getAgentMessage(agentContext, {
        associatedRecordId: credentialExchangeRecord.id,
        messageClass: V2OfferCredentialMessage,
        role: DidCommMessageRole.Receiver,
      })

      formatServices = this.getFormatServicesFromMessage(offerMessage.formats)
    }

    // If the format services list is still empty, throw an error as we don't support any
    // of the formats
    if (formatServices.length === 0) {
      throw new CredoError('Unable to accept offer. No supported formats provided as input or in offer message')
    }

    const message = await this.credentialFormatCoordinator.acceptOffer(agentContext, {
      credentialExchangeRecord,
      formatServices,
      comment,
      goal,
      goalCode,
      credentialFormats,
    })

    credentialExchangeRecord.autoAcceptCredential = autoAcceptCredential ?? credentialExchangeRecord.autoAcceptCredential
    await this.updateState(agentContext, credentialExchangeRecord, DidCommCredentialState.RequestSent)

    return { credentialExchangeRecord, message }
  }

  /**
   * Create a {@link ProposePresentationMessage} as response to a received credential offer.
   * To create a proposal not bound to an existing credential exchange, use {@link createProposal}.
   *
   * @param options configuration to use for the proposal
   * @returns Object containing proposal message and associated credential record
   *
   */
  public async negotiateOffer(
    agentContext: AgentContext,
    {
      credentialExchangeRecord,
      credentialFormats,
      autoAcceptCredential,
      comment,
      goal,
      goalCode,
    }: NegotiateCredentialOfferOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<V2ProposeCredentialMessage>> {
    // Assert
    credentialExchangeRecord.assertProtocolVersion('v2')
    credentialExchangeRecord.assertState(DidCommCredentialState.OfferReceived)

    if (!credentialExchangeRecord.connectionId) {
      throw new CredoError(
        `No connectionId found for credential record '${credentialExchangeRecord.id}'. Connection-less issuance does not support negotiation.`
      )
    }

    const formatServices = this.getFormatServices(credentialFormats)
    if (formatServices.length === 0) {
      throw new CredoError('Unable to create proposal. No supported formats')
    }

    const proposalMessage = await this.credentialFormatCoordinator.createProposal(agentContext, {
      formatServices,
      credentialFormats,
      credentialExchangeRecord,
      comment,
      goal,
      goalCode,
    })

    credentialExchangeRecord.autoAcceptCredential = autoAcceptCredential ?? credentialExchangeRecord.autoAcceptCredential
    await this.updateState(agentContext, credentialExchangeRecord, DidCommCredentialState.ProposalSent)

    return { credentialExchangeRecord, message: proposalMessage }
  }

  /**
   * Create a {@link V2RequestCredentialMessage} as beginning of protocol process.
   * @returns Object containing offer message and associated credential record
   *
   */
  public async createRequest(
    agentContext: AgentContext,
    {
      credentialFormats,
      autoAcceptCredential,
      comment,
      goal,
      goalCode,
      connectionRecord,
    }: CreateCredentialRequestOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<V2RequestCredentialMessage>> {
    const credentialRepository = agentContext.dependencyManager.resolve(DidCommCredentialExchangeRepository)

    const formatServices = this.getFormatServices(credentialFormats)
    if (formatServices.length === 0) {
      throw new CredoError('Unable to create request. No supported formats')
    }

    const credentialExchangeRecord = new DidCommCredentialExchangeRecord({
      connectionId: connectionRecord.id,
      threadId: utils.uuid(),
      state: DidCommCredentialState.RequestSent,
      role: DidCommCredentialRole.Holder,
      autoAcceptCredential,
      protocolVersion: 'v2',
    })

    const requestMessage = await this.credentialFormatCoordinator.createRequest(agentContext, {
      formatServices,
      credentialFormats,
      credentialExchangeRecord,
      comment,
      goal,
      goalCode,
    })

    agentContext.config.logger.debug(
      `Saving record and emitting state changed for credential exchange record ${credentialExchangeRecord.id}`
    )
    await credentialRepository.save(agentContext, credentialExchangeRecord)
    this.emitStateChangedEvent(agentContext, credentialExchangeRecord, null)

    return { credentialExchangeRecord, message: requestMessage }
  }

  /**
   * Process a received {@link RequestCredentialMessage}. This will not accept the credential request
   * or send a credential. It will only update the existing credential record with
   * the information from the credential request message. Use {@link createCredential}
   * after calling this method to create a credential.
   *z
   * @param messageContext The message context containing a v2 credential request message
   * @returns credential record associated with the credential request message
   *
   */
  public async processRequest(
    messageContext: InboundDidCommMessageContext<V2RequestCredentialMessage>
  ): Promise<DidCommCredentialExchangeRecord> {
    const { message: requestMessage, connection, agentContext } = messageContext

    const credentialRepository = agentContext.dependencyManager.resolve(DidCommCredentialExchangeRepository)
    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)
    const connectionService = agentContext.dependencyManager.resolve(DidCommConnectionService)

    agentContext.config.logger.debug(`Processing credential request with id ${requestMessage.id}`)

    let credentialExchangeRecord = await this.findByProperties(messageContext.agentContext, {
      threadId: requestMessage.threadId,
      role: DidCommCredentialRole.Issuer,
    })

    const formatServices = this.getFormatServicesFromMessage(requestMessage.formats)
    if (formatServices.length === 0) {
      throw new CredoError('Unable to process request. No supported formats')
    }

    // credential record already exists
    if (credentialExchangeRecord) {
      const proposalMessage = await didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
        associatedRecordId: credentialExchangeRecord.id,
        messageClass: V2ProposeCredentialMessage,
        role: DidCommMessageRole.Receiver,
      })

      const offerMessage = await didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
        associatedRecordId: credentialExchangeRecord.id,
        messageClass: V2OfferCredentialMessage,
        role: DidCommMessageRole.Sender,
      })

      // Assert
      credentialExchangeRecord.assertProtocolVersion('v2')
      credentialExchangeRecord.assertState(DidCommCredentialState.OfferSent)
      await connectionService.assertConnectionOrOutOfBandExchange(messageContext, {
        lastReceivedMessage: proposalMessage ?? undefined,
        lastSentMessage: offerMessage ?? undefined,
        expectedConnectionId: credentialExchangeRecord.connectionId,
      })

      // This makes sure that the sender of the incoming message is authorized to do so.
      if (!credentialExchangeRecord.connectionId) {
        await connectionService.matchIncomingMessageToRequestMessageInOutOfBandExchange(messageContext, {
          expectedConnectionId: credentialExchangeRecord.connectionId,
        })

        credentialExchangeRecord.connectionId = connection?.id
      }

      await this.credentialFormatCoordinator.processRequest(messageContext.agentContext, {
        credentialExchangeRecord,
        formatServices,
        message: requestMessage,
      })

      await this.updateState(messageContext.agentContext, credentialExchangeRecord, DidCommCredentialState.RequestReceived)
      return credentialExchangeRecord
    }
    // Assert
    await connectionService.assertConnectionOrOutOfBandExchange(messageContext)

    // No credential record exists with thread id
    agentContext.config.logger.debug('No credential record found for request, creating a new one')
    credentialExchangeRecord = new DidCommCredentialExchangeRecord({
      connectionId: connection?.id,
      threadId: requestMessage.threadId,
      parentThreadId: requestMessage.thread?.parentThreadId,
      state: DidCommCredentialState.RequestReceived,
      role: DidCommCredentialRole.Issuer,
      protocolVersion: 'v2',
    })

    await this.credentialFormatCoordinator.processRequest(messageContext.agentContext, {
      credentialExchangeRecord,
      formatServices,
      message: requestMessage,
    })

    // Save in repository
    agentContext.config.logger.debug('Saving credential record and emit request-received event')
    await credentialRepository.save(messageContext.agentContext, credentialExchangeRecord)

    this.emitStateChangedEvent(messageContext.agentContext, credentialExchangeRecord, null)
    return credentialExchangeRecord
  }

  public async acceptRequest(
    agentContext: AgentContext,
    {
      credentialExchangeRecord,
      autoAcceptCredential,
      comment,
      goal,
      goalCode,
      credentialFormats,
    }: AcceptCredentialRequestOptions<CFs>
  ) {
    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)

    // Assert
    credentialExchangeRecord.assertProtocolVersion('v2')
    credentialExchangeRecord.assertState(DidCommCredentialState.RequestReceived)

    // Use empty credentialFormats if not provided to denote all formats should be accepted
    let formatServices = this.getFormatServices(credentialFormats ?? {})

    // if no format services could be extracted from the credentialFormats
    // take all available format services from the request message
    if (formatServices.length === 0) {
      const requestMessage = await didCommMessageRepository.getAgentMessage(agentContext, {
        associatedRecordId: credentialExchangeRecord.id,
        messageClass: V2RequestCredentialMessage,
        role: DidCommMessageRole.Receiver,
      })

      formatServices = this.getFormatServicesFromMessage(requestMessage.formats)
    }

    // If the format services list is still empty, throw an error as we don't support any
    // of the formats
    if (formatServices.length === 0) {
      throw new CredoError('Unable to accept request. No supported formats provided as input or in request message')
    }
    const message = await this.credentialFormatCoordinator.acceptRequest(agentContext, {
      credentialExchangeRecord,
      formatServices,
      comment,
      goal,
      goalCode,
      credentialFormats,
    })

    credentialExchangeRecord.autoAcceptCredential = autoAcceptCredential ?? credentialExchangeRecord.autoAcceptCredential
    await this.updateState(agentContext, credentialExchangeRecord, DidCommCredentialState.CredentialIssued)

    return { credentialExchangeRecord, message }
  }

  /**
   * Process a received {@link V2IssueCredentialMessage}. This will not accept the credential
   * or send a credential acknowledgement. It will only update the existing credential record with
   * the information from the issue credential message. Use {@link createAck}
   * after calling this method to create a credential acknowledgement.
   *
   * @param messageContext The message context containing an issue credential message
   *
   * @returns credential record associated with the issue credential message
   *
   */
  public async processCredential(
    messageContext: InboundDidCommMessageContext<V2IssueCredentialMessage>
  ): Promise<DidCommCredentialExchangeRecord> {
    const { message: credentialMessage, connection, agentContext } = messageContext

    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)
    const connectionService = agentContext.dependencyManager.resolve(DidCommConnectionService)

    agentContext.config.logger.debug(`Processing credential with id ${credentialMessage.id}`)

    const credentialExchangeRecord = await this.getByProperties(messageContext.agentContext, {
      threadId: credentialMessage.threadId,
      role: DidCommCredentialRole.Holder,
      connectionId: connection?.id,
    })

    const requestMessage = await didCommMessageRepository.getAgentMessage(messageContext.agentContext, {
      associatedRecordId: credentialExchangeRecord.id,
      messageClass: V2RequestCredentialMessage,
      role: DidCommMessageRole.Sender,
    })
    const offerMessage = await didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
      associatedRecordId: credentialExchangeRecord.id,
      messageClass: V2OfferCredentialMessage,
      role: DidCommMessageRole.Receiver,
    })

    // Assert
    credentialExchangeRecord.assertProtocolVersion('v2')
    credentialExchangeRecord.assertState(DidCommCredentialState.RequestSent)
    await connectionService.assertConnectionOrOutOfBandExchange(messageContext, {
      lastReceivedMessage: offerMessage ?? undefined,
      lastSentMessage: requestMessage,
      expectedConnectionId: credentialExchangeRecord.connectionId,
    })

    const formatServices = this.getFormatServicesFromMessage(credentialMessage.formats)
    if (formatServices.length === 0) {
      throw new CredoError('Unable to process credential. No supported formats')
    }

    await this.credentialFormatCoordinator.processCredential(messageContext.agentContext, {
      credentialExchangeRecord,
      formatServices,
      requestMessage: requestMessage,
      message: credentialMessage,
    })

    await this.updateState(messageContext.agentContext, credentialExchangeRecord, DidCommCredentialState.CredentialReceived)

    return credentialExchangeRecord
  }

  /**
   * Create a {@link V2CredentialAckMessage} as response to a received credential.
   *
   * @param credentialExchangeRecord The credential record for which to create the credential acknowledgement
   * @returns Object containing credential acknowledgement message and associated credential record
   *
   */
  public async acceptCredential(
    agentContext: AgentContext,
    { credentialExchangeRecord }: AcceptCredentialOptions
  ): Promise<CredentialProtocolMsgReturnType<V2CredentialAckMessage>> {
    credentialExchangeRecord.assertProtocolVersion('v2')
    credentialExchangeRecord.assertState(DidCommCredentialState.CredentialReceived)

    // Create message
    const ackMessage = new V2CredentialAckMessage({
      status: AckStatus.OK,
      threadId: credentialExchangeRecord.threadId,
    })

    ackMessage.setThread({ threadId: credentialExchangeRecord.threadId, parentThreadId: credentialExchangeRecord.parentThreadId })

    await this.updateState(agentContext, credentialExchangeRecord, DidCommCredentialState.Done)

    return { message: ackMessage, credentialExchangeRecord }
  }

  /**
   * Process a received {@link CredentialAckMessage}.
   *
   * @param messageContext The message context containing a credential acknowledgement message
   * @returns credential record associated with the credential acknowledgement message
   *
   */
  public async processAck(
    messageContext: InboundDidCommMessageContext<V2CredentialAckMessage>
  ): Promise<DidCommCredentialExchangeRecord> {
    const { message: ackMessage, connection, agentContext } = messageContext

    agentContext.config.logger.debug(`Processing credential ack with id ${ackMessage.id}`)

    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)
    const connectionService = agentContext.dependencyManager.resolve(DidCommConnectionService)

    const credentialExchangeRecord = await this.getByProperties(messageContext.agentContext, {
      threadId: ackMessage.threadId,
      role: DidCommCredentialRole.Issuer,
      connectionId: connection?.id,
    })
    credentialExchangeRecord.connectionId = connection?.id

    const requestMessage = await didCommMessageRepository.getAgentMessage(messageContext.agentContext, {
      associatedRecordId: credentialExchangeRecord.id,
      messageClass: V2RequestCredentialMessage,
      role: DidCommMessageRole.Receiver,
    })

    const credentialMessage = await didCommMessageRepository.getAgentMessage(messageContext.agentContext, {
      associatedRecordId: credentialExchangeRecord.id,
      messageClass: V2IssueCredentialMessage,
      role: DidCommMessageRole.Sender,
    })

    // Assert
    credentialExchangeRecord.assertProtocolVersion('v2')
    credentialExchangeRecord.assertState(DidCommCredentialState.CredentialIssued)
    await connectionService.assertConnectionOrOutOfBandExchange(messageContext, {
      lastReceivedMessage: requestMessage,
      lastSentMessage: credentialMessage,
      expectedConnectionId: credentialExchangeRecord.connectionId,
    })

    // Update record
    await this.updateState(messageContext.agentContext, credentialExchangeRecord, DidCommCredentialState.Done)

    return credentialExchangeRecord
  }

  /**
   * Create a {@link V2CredentialProblemReportMessage} to be sent.
   *
   * @param message message to send
   * @returns a {@link V2CredentialProblemReportMessage}
   *
   */
  public async createProblemReport(
    _agentContext: AgentContext,
    { credentialExchangeRecord, description }: CreateCredentialProblemReportOptions
  ): Promise<CredentialProtocolMsgReturnType<ProblemReportMessage>> {
    const message = new V2CredentialProblemReportMessage({
      description: {
        en: description,
        code: DidCommCredentialProblemReportReason.IssuanceAbandoned,
      },
    })

    message.setThread({ threadId: credentialExchangeRecord.threadId, parentThreadId: credentialExchangeRecord.parentThreadId })

    return { credentialExchangeRecord, message }
  }

  // AUTO ACCEPT METHODS
  public async shouldAutoRespondToProposal(
    agentContext: AgentContext,
    options: {
      credentialExchangeRecord: DidCommCredentialExchangeRecord
      proposalMessage: V2ProposeCredentialMessage
    }
  ): Promise<boolean> {
    const { credentialExchangeRecord, proposalMessage } = options
    const credentialsModuleConfig = agentContext.dependencyManager.resolve(DidCommCredentialsModuleConfig)

    const autoAccept = composeAutoAccept(
      credentialExchangeRecord.autoAcceptCredential,
      credentialsModuleConfig.autoAcceptCredentials
    )

    // Handle always / never cases
    if (autoAccept === DidCommAutoAcceptCredential.Always) return true
    if (autoAccept === DidCommAutoAcceptCredential.Never) return false

    const offerMessage = await this.findOfferMessage(agentContext, credentialExchangeRecord.id)
    if (!offerMessage) return false

    // NOTE: we take the formats from the offerMessage so we always check all services that we last sent
    // Otherwise we'll only check the formats from the proposal, which could be different from the formats
    // we use.
    const formatServices = this.getFormatServicesFromMessage(offerMessage.formats)

    for (const formatService of formatServices) {
      const offerAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        offerMessage.formats,
        offerMessage.offerAttachments
      )

      const proposalAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        proposalMessage.formats,
        proposalMessage.proposalAttachments
      )

      const shouldAutoRespondToFormat = await formatService.shouldAutoRespondToProposal(agentContext, {
        credentialExchangeRecord,
        offerAttachment,
        proposalAttachment,
      })
      // If any of the formats return false, we should not auto accept
      if (!shouldAutoRespondToFormat) return false
    }

    // not all formats use the proposal and preview, we only check if they're present on
    // either or both of the messages
    if (proposalMessage.credentialPreview || offerMessage.credentialPreview) {
      // if one of the message doesn't have a preview, we should not auto accept
      if (!proposalMessage.credentialPreview || !offerMessage.credentialPreview) return false

      // Check if preview values match
      return arePreviewAttributesEqual(
        proposalMessage.credentialPreview.attributes,
        offerMessage.credentialPreview.attributes
      )
    }

    return true
  }

  public async shouldAutoRespondToOffer(
    agentContext: AgentContext,
    options: {
      credentialExchangeRecord: DidCommCredentialExchangeRecord
      offerMessage: V2OfferCredentialMessage
    }
  ): Promise<boolean> {
    const { credentialExchangeRecord, offerMessage } = options
    const credentialsModuleConfig = agentContext.dependencyManager.resolve(DidCommCredentialsModuleConfig)

    const autoAccept = composeAutoAccept(
      credentialExchangeRecord.autoAcceptCredential,
      credentialsModuleConfig.autoAcceptCredentials
    )
    // Handle always / never cases
    if (autoAccept === DidCommAutoAcceptCredential.Always) return true
    if (autoAccept === DidCommAutoAcceptCredential.Never) return false

    const proposalMessage = await this.findProposalMessage(agentContext, credentialExchangeRecord.id)
    if (!proposalMessage) return false

    // NOTE: we take the formats from the proposalMessage so we always check all services that we last sent
    // Otherwise we'll only check the formats from the offer, which could be different from the formats
    // we use.
    const formatServices = this.getFormatServicesFromMessage(proposalMessage.formats)

    for (const formatService of formatServices) {
      const offerAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        offerMessage.formats,
        offerMessage.offerAttachments
      )

      const proposalAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        proposalMessage.formats,
        proposalMessage.proposalAttachments
      )

      const shouldAutoRespondToFormat = await formatService.shouldAutoRespondToOffer(agentContext, {
        credentialExchangeRecord,
        offerAttachment,
        proposalAttachment,
      })

      // If any of the formats return false, we should not auto accept

      if (!shouldAutoRespondToFormat) return false
    }

    // if one of the message doesn't have a preview, we should not auto accept
    if (proposalMessage.credentialPreview || offerMessage.credentialPreview) {
      // Check if preview values match
      return arePreviewAttributesEqual(
        proposalMessage.credentialPreview?.attributes ?? [],
        offerMessage.credentialPreview?.attributes ?? []
      )
    }
    return true
  }

  public async shouldAutoRespondToRequest(
    agentContext: AgentContext,
    options: {
      credentialExchangeRecord: DidCommCredentialExchangeRecord
      requestMessage: V2RequestCredentialMessage
    }
  ): Promise<boolean> {
    const { credentialExchangeRecord, requestMessage } = options
    const credentialsModuleConfig = agentContext.dependencyManager.resolve(DidCommCredentialsModuleConfig)

    const autoAccept = composeAutoAccept(
      credentialExchangeRecord.autoAcceptCredential,
      credentialsModuleConfig.autoAcceptCredentials
    )

    // Handle always / never cases
    if (autoAccept === DidCommAutoAcceptCredential.Always) return true
    if (autoAccept === DidCommAutoAcceptCredential.Never) return false

    const proposalMessage = await this.findProposalMessage(agentContext, credentialExchangeRecord.id)

    const offerMessage = await this.findOfferMessage(agentContext, credentialExchangeRecord.id)
    if (!offerMessage) return false

    // NOTE: we take the formats from the offerMessage so we always check all services that we last sent
    // Otherwise we'll only check the formats from the request, which could be different from the formats
    // we use.
    const formatServices = this.getFormatServicesFromMessage(offerMessage.formats)

    for (const formatService of formatServices) {
      const offerAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        offerMessage.formats,
        offerMessage.offerAttachments
      )

      const proposalAttachment = proposalMessage
        ? this.credentialFormatCoordinator.getAttachmentForService(
            formatService,
            proposalMessage.formats,
            proposalMessage.proposalAttachments
          )
        : undefined

      const requestAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        requestMessage.formats,
        requestMessage.requestAttachments
      )

      const shouldAutoRespondToFormat = await formatService.shouldAutoRespondToRequest(agentContext, {
        credentialExchangeRecord,
        offerAttachment,
        requestAttachment,
        proposalAttachment,
      })

      // If any of the formats return false, we should not auto accept
      if (!shouldAutoRespondToFormat) return false
    }

    return true
  }

  public async shouldAutoRespondToCredential(
    agentContext: AgentContext,
    options: {
      credentialExchangeRecord: DidCommCredentialExchangeRecord
      credentialMessage: V2IssueCredentialMessage
    }
  ): Promise<boolean> {
    const { credentialExchangeRecord, credentialMessage } = options
    const credentialsModuleConfig = agentContext.dependencyManager.resolve(DidCommCredentialsModuleConfig)

    const autoAccept = composeAutoAccept(
      credentialExchangeRecord.autoAcceptCredential,
      credentialsModuleConfig.autoAcceptCredentials
    )

    // Handle always / never cases
    if (autoAccept === DidCommAutoAcceptCredential.Always) return true
    if (autoAccept === DidCommAutoAcceptCredential.Never) return false

    const proposalMessage = await this.findProposalMessage(agentContext, credentialExchangeRecord.id)
    const offerMessage = await this.findOfferMessage(agentContext, credentialExchangeRecord.id)

    const requestMessage = await this.findRequestMessage(agentContext, credentialExchangeRecord.id)
    if (!requestMessage) return false

    // NOTE: we take the formats from the requestMessage so we always check all services that we last sent
    // Otherwise we'll only check the formats from the credential, which could be different from the formats
    // we use.
    const formatServices = this.getFormatServicesFromMessage(requestMessage.formats)

    for (const formatService of formatServices) {
      const offerAttachment = offerMessage
        ? this.credentialFormatCoordinator.getAttachmentForService(
            formatService,
            offerMessage.formats,
            offerMessage.offerAttachments
          )
        : undefined

      const proposalAttachment = proposalMessage
        ? this.credentialFormatCoordinator.getAttachmentForService(
            formatService,
            proposalMessage.formats,
            proposalMessage.proposalAttachments
          )
        : undefined

      const requestAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        requestMessage.formats,
        requestMessage.requestAttachments
      )

      const credentialAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        credentialMessage.formats,
        credentialMessage.credentialAttachments
      )

      const shouldAutoRespondToFormat = await formatService.shouldAutoRespondToCredential(agentContext, {
        credentialExchangeRecord,
        offerAttachment,
        credentialAttachment,
        requestAttachment,
        proposalAttachment,
      })

      // If any of the formats return false, we should not auto accept
      if (!shouldAutoRespondToFormat) return false
    }
    return true
  }

  public async findProposalMessage(agentContext: AgentContext, credentialExchangeId: string) {
    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)

    return didCommMessageRepository.findAgentMessage(agentContext, {
      associatedRecordId: credentialExchangeId,
      messageClass: V2ProposeCredentialMessage,
    })
  }

  public async findOfferMessage(agentContext: AgentContext, credentialExchangeId: string) {
    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)

    return await didCommMessageRepository.findAgentMessage(agentContext, {
      associatedRecordId: credentialExchangeId,
      messageClass: V2OfferCredentialMessage,
    })
  }

  public async findRequestMessage(agentContext: AgentContext, credentialExchangeId: string) {
    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)

    return await didCommMessageRepository.findAgentMessage(agentContext, {
      associatedRecordId: credentialExchangeId,
      messageClass: V2RequestCredentialMessage,
    })
  }

  public async findCredentialMessage(agentContext: AgentContext, credentialExchangeId: string) {
    const didCommMessageRepository = agentContext.dependencyManager.resolve(DidCommMessageRepository)

    return await didCommMessageRepository.findAgentMessage(agentContext, {
      associatedRecordId: credentialExchangeId,
      messageClass: V2IssueCredentialMessage,
    })
  }

  public async getFormatData(
    agentContext: AgentContext,
    credentialExchangeId: string
  ): Promise<GetCredentialFormatDataReturn<ExtractCredentialFormats<CFs>>> {
    // TODO: we could looking at fetching all record using a single query and then filtering based on the type of the message.
    const [proposalMessage, offerMessage, requestMessage, credentialMessage] = await Promise.all([
      this.findProposalMessage(agentContext, credentialExchangeId),
      this.findOfferMessage(agentContext, credentialExchangeId),
      this.findRequestMessage(agentContext, credentialExchangeId),
      this.findCredentialMessage(agentContext, credentialExchangeId),
    ])

    // Create object with the keys and the message formats/attachments. We can then loop over this in a generic
    // way so we don't have to add the same operation code four times
    const messages = {
      proposal: [proposalMessage?.formats, proposalMessage?.proposalAttachments],
      offer: [offerMessage?.formats, offerMessage?.offerAttachments],
      request: [requestMessage?.formats, requestMessage?.requestAttachments],
      credential: [credentialMessage?.formats, credentialMessage?.credentialAttachments],
    } as const

    const formatData: GetCredentialFormatDataReturn = {
      proposalAttributes: proposalMessage?.credentialPreview?.attributes,
      offerAttributes: offerMessage?.credentialPreview?.attributes,
    }

    // We loop through all of the message keys as defined above
    for (const [messageKey, [formats, attachments]] of Object.entries(messages)) {
      // Message can be undefined, so we continue if it is not defined
      if (!formats || !attachments) continue

      // Find all format services associated with the message
      const formatServices = this.getFormatServicesFromMessage(formats)
      const messageFormatData: CredentialFormatDataMessagePayload = {}

      // Loop through all of the format services, for each we will extract the attachment data and assign this to the object
      // using the unique format key (e.g. indy)
      for (const formatService of formatServices) {
        const attachment = this.credentialFormatCoordinator.getAttachmentForService(formatService, formats, attachments)

        messageFormatData[formatService.formatKey] = attachment.getDataAsJson()
      }

      formatData[messageKey as Exclude<keyof GetCredentialFormatDataReturn, 'proposalAttributes' | 'offerAttributes'>] =
        messageFormatData
    }

    return formatData
  }

  /**
   * Get all the format service objects for a given credential format from an incoming message
   * @param messageFormats the format objects containing the format name (eg indy)
   * @return the credential format service objects in an array - derived from format object keys
   */
  private getFormatServicesFromMessage(messageFormats: DidCommCredentialFormatSpec[]): CredentialFormatService[] {
    const formatServices = new Set<CredentialFormatService>()

    for (const msg of messageFormats) {
      const service = this.getFormatServiceForFormat(msg.format)
      if (service) formatServices.add(service)
    }

    return Array.from(formatServices)
  }

  /**
   * Get all the format service objects for a given credential format
   * @param credentialFormats the format object containing various optional parameters
   * @return the credential format service objects in an array - derived from format object keys
   */
  private getFormatServices<M extends keyof CredentialFormat['credentialFormats']>(
    credentialFormats: CredentialFormatPayload<ExtractCredentialFormats<CFs>, M>
  ): CredentialFormatService[] {
    const formats = new Set<CredentialFormatService>()

    for (const formatKey of Object.keys(credentialFormats)) {
      const formatService = this.getFormatServiceForFormatKey(formatKey)

      if (formatService) formats.add(formatService)
    }

    return Array.from(formats)
  }

  private getFormatServiceForFormatKey(formatKey: string): CredentialFormatService | null {
    const formatService = this.credentialFormats.find((credentialFormat) => credentialFormat.formatKey === formatKey)

    return formatService ?? null
  }

  private getFormatServiceForFormat(format: string): CredentialFormatService | null {
    const formatService = this.credentialFormats.find((credentialFormat) => credentialFormat.supportsFormat(format))

    return formatService ?? null
  }

  protected getFormatServiceForRecordType(credentialRecordType: string) {
    const formatService = this.credentialFormats.find(
      (credentialFormat) => credentialFormat.credentialRecordType === credentialRecordType
    )

    if (!formatService) {
      throw new CredoError(
        `No format service found for credential record type ${credentialRecordType} in v2 credential protocol`
      )
    }

    return formatService
  }
}
