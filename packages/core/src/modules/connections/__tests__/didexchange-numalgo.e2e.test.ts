/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { ConnectionStateChangedEvent } from '../ConnectionEvents'

import { firstValueFrom } from 'rxjs'
import { filter, first, map, timeout } from 'rxjs/operators'

import { getIndySdkModules } from '../../../../../indy-sdk/tests/setupIndySdkModule'
import { setupSubjectTransports } from '../../../../tests'
import { getAgentOptions } from '../../../../tests/helpers'
import { Agent } from '../../../agent/Agent'
import { PeerDidNumAlgo } from '../../dids'
import { ConnectionEventTypes } from '../ConnectionEvents'
import { ConnectionsModule } from '../ConnectionsModule'
import { DidExchangeState } from '../models'

function waitForRequest(agent: Agent, theirLabel: string) {
  return firstValueFrom(
    agent.events.observable<ConnectionStateChangedEvent>(ConnectionEventTypes.ConnectionStateChanged).pipe(
      map((event) => event.payload.connectionRecord),
      // Wait for request received
      filter(
        (connectionRecord) =>
          connectionRecord.state === DidExchangeState.RequestReceived && connectionRecord.theirLabel === theirLabel
      ),
      first(),
      timeout(5000)
    )
  )
}

function waitForResponse(agent: Agent, connectionId: string) {
  return firstValueFrom(
    agent.events.observable<ConnectionStateChangedEvent>(ConnectionEventTypes.ConnectionStateChanged).pipe(
      // Wait for response received
      map((event) => event.payload.connectionRecord),
      filter(
        (connectionRecord) =>
          connectionRecord.state === DidExchangeState.ResponseReceived && connectionRecord.id === connectionId
      ),
      first(),
      timeout(5000)
    )
  )
}

describe('Did Exchange numalgo settings', () => {
  test('Connect using default setting (numalgo 1)', async () => {
    await didExchangeNumAlgoBaseTest({})
  })

  test('Connect using default setting for requester and numalgo 2 for responder', async () => {
    await didExchangeNumAlgoBaseTest({ responderNumAlgoSetting: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc })
  })

  test('Connect using numalgo 2 for requester and default setting for responder', async () => {
    await didExchangeNumAlgoBaseTest({ requesterNumAlgoSetting: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc })
  })

  test('Connect using numalgo 2 for both requester and responder', async () => {
    await didExchangeNumAlgoBaseTest({
      requesterNumAlgoSetting: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc,
      responderNumAlgoSetting: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc,
    })
  })
})

async function didExchangeNumAlgoBaseTest(options: {
  requesterNumAlgoSetting?: PeerDidNumAlgo
  responderNumAlgoSetting?: PeerDidNumAlgo
}) {
  const aliceAgentOptions = getAgentOptions(
    'Manual Connection Flow Alice',
    {
      label: 'alice',
      endpoints: ['rxjs:alice'],
    },
    {
      ...getIndySdkModules(),
      connections: new ConnectionsModule({
        autoAcceptConnections: false,
        peerNumAlgoForDidExchangeRequests: options.requesterNumAlgoSetting,
      }),
    }
  )
  const faberAgentOptions = getAgentOptions(
    'Manual Connection Flow Faber',
    {
      endpoints: ['rxjs:faber'],
    },
    {
      ...getIndySdkModules(),
      connections: new ConnectionsModule({
        autoAcceptConnections: false,
        peerNumAlgoForDidExchangeRequests: options.responderNumAlgoSetting,
      }),
    }
  )

  const aliceAgent = new Agent(aliceAgentOptions)
  const faberAgent = new Agent(faberAgentOptions)

  setupSubjectTransports([aliceAgent, faberAgent])
  await aliceAgent.initialize()
  await faberAgent.initialize()

  const faberOutOfBandRecord = await faberAgent.oob.createInvitation({
    autoAcceptConnection: false,
    multiUseInvitation: false,
  })

  const waitForAliceRequest = waitForRequest(faberAgent, 'alice')

  let { connectionRecord: aliceConnectionRecord } = await aliceAgent.oob.receiveInvitation(
    faberOutOfBandRecord.outOfBandInvitation,
    {
      autoAcceptInvitation: true,
      autoAcceptConnection: false,
    }
  )

  let faberAliceConnectionRecord = await waitForAliceRequest

  const waitForAliceResponse = waitForResponse(aliceAgent, aliceConnectionRecord!.id)

  await faberAgent.connections.acceptRequest(faberAliceConnectionRecord.id)

  aliceConnectionRecord = await waitForAliceResponse
  await aliceAgent.connections.acceptResponse(aliceConnectionRecord!.id)

  aliceConnectionRecord = await aliceAgent.connections.returnWhenIsConnected(aliceConnectionRecord!.id)
  faberAliceConnectionRecord = await faberAgent.connections.returnWhenIsConnected(faberAliceConnectionRecord!.id)

  expect(aliceConnectionRecord).toBeConnectedWith(faberAliceConnectionRecord)

  await aliceAgent.wallet.delete()
  await aliceAgent.shutdown()

  await faberAgent.wallet.delete()
  await faberAgent.shutdown()
}
