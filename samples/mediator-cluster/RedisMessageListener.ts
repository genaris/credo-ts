import type { Logger } from '@aries-framework/core'
import type { RedisClientType, RedisFunctions, RedisModules, RedisScripts } from '@redis/client'

// eslint-disable-next-line import/no-extraneous-dependencies
import { createClient } from '@redis/client'

type MessageConverter = (msg: string) => Set<string>
type QueuedMessagesListener = (connectionId: string) => void
export interface IRedisMessageListenerConfig {
  host: string
  port: number
  channel_name: string
  converter: MessageConverter
  listener: QueuedMessagesListener
}

export default class RedisMessageListener {
  private readonly channel: string
  private readonly converter: MessageConverter
  private readonly onQueuedMessages: (connectionId: string) => void
  private readonly client: RedisClientType<RedisModules, RedisFunctions, RedisScripts>
  public constructor(config: IRedisMessageListenerConfig) {
    const url = `redis://${config.host}:${config.port}`
    this.channel = config.channel_name
    this.converter = config.converter
    this.client = createClient({ url })
    this.onQueuedMessages = config.listener
  }

  public async initialize(logger: Logger) {
    await this.client
      .on('error', (err) => logger.error('Redis Client Error', err))
      .connect()
      .then(async (client) => await client.subscribe(this.channel, this.messageReceived))
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private messageReceived(message: string, channel: string): void {
    const connectionIds = this.converter(message)
    connectionIds.forEach((connectionId: string) => this.onQueuedMessages(connectionId))
  }
}
