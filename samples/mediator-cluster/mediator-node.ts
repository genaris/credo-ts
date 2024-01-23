/* eslint-disable import/no-extraneous-dependencies */
// noinspection DuplicatedCode

/**
 * This file contains a sample mediator. The mediator supports both
 * HTTP and WebSockets for communication and will automatically accept
 * incoming mediation requests.
 *
 * You can get an invitation by going to '/invitation', which by default is
 * http://localhost:3001/invitation
 *
 * To connect to the mediator from another agent, you can set the
 * 'mediatorConnectionsInvite' parameter in the agent config to the
 * url that is returned by the '/invitation/' endpoint. This will connect
 * to the mediator, request mediation and set the mediator as default.
 */

import type { IPostgreSQLConfig } from './PostgreSQLMessageRepository'
import type { IRedisMessageListenerConfig } from './RedisMessageListener'
import type { AskarWalletPostgresStorageConfig } from '@aries-framework/askar'
import type { InitConfig, MediatorApi, MediatorService, MessagePickupApi } from '@aries-framework/core'
import type { Socket } from 'net'

import 'reflect-metadata' // for tsyringe
import { ariesAskar } from '@hyperledger/aries-askar-nodejs'
import express from 'express'
import { Server } from 'ws'

import { TestLogger } from '../../packages/core/tests/logger'

import { PostgreSQLMessageRepository } from './PostgreSQLMessageRepository'
import RedisMessageListener from './RedisMessageListener'

import { AskarModule } from '@aries-framework/askar'
import {
  Agent,
  ConnectionInvitationMessage,
  ConnectionsModule,
  DependencyManager,
  HttpOutboundTransport,
  InjectionSymbols,
  LogLevel,
  MediatorModule,
  WsOutboundTransport,
} from '@aries-framework/core'
import { MessageForwardingStrategy } from '@aries-framework/core/src/modules/routing/MessageForwardingStrategy'
import { agentDependencies, HttpInboundTransport, WsInboundTransport } from '@aries-framework/node'

const port = process.env.AGENT_PORT ? Number(process.env.AGENT_PORT) : 3001

// We create our own instance of express here. This is not required
// but allows use to use the same server (and port) for both WebSockets and HTTP
const app = express()
const socketServer = new Server({ noServer: true })

const endpoints = process.env.AGENT_ENDPOINTS?.split(',') ?? [`http://localhost:${port}`, `ws://localhost:${port}`]

const logger = new TestLogger(LogLevel.info)

const POSTGRESQL_WALLET_HOST = process.env.POSTGRESQL_WALLET_HOST || 'localhost'
const POSTGRESQL_WALLET_PORT = process.env.POSTGRESQL_WALLET_PORT ? Number(process.env.POSTGRESQL_WALLET_PORT) : 5432

const walletStoragePgSqlConfig: AskarWalletPostgresStorageConfig = {
  type: 'postgres',
  config: {
    host: `${POSTGRESQL_WALLET_HOST}:${POSTGRESQL_WALLET_PORT}`,
  },
  credentials: {
    account: process.env.POSTGRESQL_WALLET_USER || 'postgres',
    password: process.env.POSTGRESQL_WALLET_PASSWORD || 'postgres',
    adminAccount: process.env.POSTGRESQL_WALLET_ADMIN_USER || 'postgres',
    adminPassword: process.env.POSTGRESQL_WALLET_ADMIN_PASSWORD || 'postgres',
  },
}

const agentConfig: InitConfig = {
  endpoints,
  label: process.env.AGENT_LABEL || 'Aries Framework JavaScript Mediator',
  walletConfig: {
    id: process.env.WALLET_NAME || 'AriesFrameworkJavaScript',
    key: process.env.WALLET_KEY || 'AriesFrameworkJavaScript',
    storage: walletStoragePgSqlConfig,
  },
  logger,
}

const messagesRepoPgSqlConfig: IPostgreSQLConfig = {
  host: process.env.POSTGRESQL_MESSAGES_HOST || 'localhost',
  port: process.env.POSTGRESQL_MESSAGES_PORT ? Number(process.env.POSTGRESQL_MESSAGES_PORT) : 5432,
  db_name: process.env.POSTGRESQL_MESSAGES_DB_NAME || 'mediator-messages',
  account: process.env.POSTGRESQL_MESSAGES_USER || 'postgres',
  password: process.env.POSTGRESQL_MESSAGES_PASSWORD || 'postgres',
  admin_account: process.env.POSTGRESQL_MESSAGES_ADMIN_USER || 'postgres',
  admin_password: process.env.POSTGRESQL_MESSAGES_ADMIN_PASSWORD || 'postgres',
}

const dependencyMgr = new DependencyManager()
dependencyMgr.registerSingleton(InjectionSymbols.MessagePickupRepository, PostgreSQLMessageRepository)

// Set up agent
const agent = new Agent(
  {
    config: agentConfig,
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({ ariesAskar }),
      mediator: new MediatorModule({
        autoAcceptMediationRequests: true,
        messageForwardingStrategy: MessageForwardingStrategy.QueueAndDeliver,
      }),
      connections: new ConnectionsModule({
        autoAcceptConnections: true,
      }),
    },
  },
  dependencyMgr
)
const config = agent.config

// Create all transports
const httpInboundTransport = new HttpInboundTransport({ app, port })
const httpOutboundTransport = new HttpOutboundTransport()
const wsInboundTransport = new WsInboundTransport({ server: socketServer })
const wsOutboundTransport = new WsOutboundTransport()

// Register all Transports
agent.registerInboundTransport(httpInboundTransport)
agent.registerOutboundTransport(httpOutboundTransport)
agent.registerInboundTransport(wsInboundTransport)
agent.registerOutboundTransport(wsOutboundTransport)

// Allow to create invitation, no other way to ask for invitation yet
httpInboundTransport.app.get('/invitation', async (req, res) => {
  if (typeof req.query.c_i === 'string') {
    const invitation = ConnectionInvitationMessage.fromUrl(req.url)
    res.send(invitation.toJSON())
  } else {
    const { outOfBandInvitation } = await agent.oob.createInvitation()
    const httpEndpoint = config.endpoints.find((e) => e.startsWith('http'))
    res.send(outOfBandInvitation.toUrl({ domain: httpEndpoint + '/invitation' }))
  }
})

// TODO need public access to messagePickupApi
const mediatorApi = agent.mediator as MediatorApi
const mediatorService = mediatorApi['mediatorService'] as MediatorService
const messagePickupApi = mediatorService['messagePickupApi'] as MessagePickupApi

const redisConfig: IRedisMessageListenerConfig = {
  host: process.env.REDIS_MESSAGES_HOST || 'localhost',
  port: process.env.REDIS_MESSAGES_PORT ? Number(process.env.REDIS_MESSAGES_PORT) : 5432,
  channel_name: 'mediator-changes',
  converter: PostgreSQLMessageRepository.convertCDCMessage,
  listener: (connectionId: string) => messagePickupApi.deliverQueuedMessages({ connectionId }),
}
const cdcEventListener = new RedisMessageListener(redisConfig)

const run = async () => {
  await PostgreSQLMessageRepository.initialize(logger, messagesRepoPgSqlConfig)
  await agent.initialize()
  await cdcEventListener.initialize(logger)

  // When an 'upgrade' to WS is made on our http server, we forward the
  // request to the WS server
  httpInboundTransport.server?.on('upgrade', (request, socket, head) => {
    socketServer.handleUpgrade(request, socket as Socket, head, (socket) => {
      socketServer.emit('connection', socket, request)
    })
  })
}

void run()
