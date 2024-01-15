import type {
  AddMessageOptions,
  EncryptedMessage,
  GetAvailableMessageCountOptions,
  MessagePickupRepository,
  QueuedMessage,
  RemoveMessagesOptions,
  TakeFromQueueOptions,
} from '@aries-framework/core'
import type { UUID } from 'crypto'
import type { Configuration } from 'ts-postgres'

import { randomUUID } from 'crypto'
import { Client, SSLMode } from 'ts-postgres'
import { inject, injectable } from 'tsyringe'

import { InjectionSymbols, Logger } from '@aries-framework/core'

export interface IPostgreSQLConfig {
  host: string
  port: number
  db_name: string
  account: string
  password: string
  admin_account: string
  admin_password: string
}

function IPostgreSQLConfigToConfiguration(config: IPostgreSQLConfig | null): Configuration | undefined {
  if (config)
    return {
      host: config.host,
      port: config.port,
      database: config.db_name,
      user: config.account,
      password: config.password,
      ssl: SSLMode.Disable,
    }
  else return undefined
}

function IPostgreSQLConfigToJSON(config: IPostgreSQLConfig | null): string {
  const serialized = { ...config, password: '*****', admin_password: '*****' }
  return JSON.stringify(serialized)
}

@injectable()
export class PostgreSQLMessageRepository implements MessagePickupRepository {
  public static CONFIG: IPostgreSQLConfig | null = null

  public static async initialize(logger: Logger, config: IPostgreSQLConfig) {
    logger.info(`Initializing message repo with config: ${IPostgreSQLConfigToJSON(config)}`)
    PostgreSQLMessageRepository.CONFIG = config
    const db_exists = await PostgreSQLMessageRepository.database_exists(logger)
    if (!db_exists) await PostgreSQLMessageRepository.do_create_database(logger)
    const schema_exists = await PostgreSQLMessageRepository.schema_exists(logger)
    if (!schema_exists) await PostgreSQLMessageRepository.do_create_schema(logger)
  }

  public static async database_exists(logger: Logger) {
    const config = PostgreSQLMessageRepository.default_config()
    if (!config) return false
    logger.debug('Checking if database exists')
    const client = new Client(config)
    try {
      await client.connect()
      try {
        const rows = await client.query('SELECT * FROM pg_catalog.pg_tables')
        logger.debug('Database already exists')
        return !!rows
      } finally {
        await client.end()
      }
    } catch (e) {
      if (e.code == '3D000') logger.info('Messages database does not exist')
      else logger.error('While connecting to messages database', e)
      return false
    }
  }

  public static async schema_exists(logger: Logger) {
    const config = PostgreSQLMessageRepository.default_config()
    if (!config) return false
    logger.debug('Checking if schema exists')
    const client = new Client(config)
    try {
      await client.connect()
      try {
        const rows = await client.query('SELECT COUNT(*) FROM messages')
        logger.debug('Schema already exists')
        return !!rows
      } catch (e) {
        if (e.code == '42P01') logger.info('Messages table does not exist')
        else logger.error('While querying database', e)
        return false
      } finally {
        await client.end()
      }
    } catch (e) {
      logger.error('While connecting to messages database', e)
      return false
    }
  }

  public static async do_create_database(logger: Logger) {
    logger.info('Creating messages database')
    const config = PostgreSQLMessageRepository.admin_config()
    const client = new Client(config)
    try {
      await client.connect()
      try {
        const stmt = `CREATE DATABASE "${PostgreSQLMessageRepository.CONFIG?.db_name}"`
        /* const rows = */ await client.query(stmt)
        logger.info(`Successfully created database "${PostgreSQLMessageRepository.CONFIG?.db_name}"`)
      } finally {
        await client.end()
      }
    } catch (e) {
      logger.error('While creating messages database', e)
      throw e
    }
  }

  public static async do_create_schema(logger: Logger) {
    logger.info('Creating messages schema')
    const config = PostgreSQLMessageRepository.default_config()
    if (!config) return false
    const client = new Client(config)
    try {
      await client.connect()
      try {
        const stmts = [
          /* gen_random_uuid not available in pgsql < 13
                    "CREATE TABLE IF NOT EXISTS MESSAGES ( uuid UUID DEFAULT gen_random_uuid() PRIMARY KEY, connection_id varchar(64) NOT NULL, timestamp TIMESTAMP WITHOUT TIME ZONE DEFAULT current_timestamp, payload JSON NOT NULL)", */
          'CREATE TABLE IF NOT EXISTS MESSAGES ( uuid UUID PRIMARY KEY, connection_id varchar(64) NOT NULL, timestamp TIMESTAMP WITHOUT TIME ZONE DEFAULT current_timestamp, payload JSON NOT NULL)',
          'CREATE INDEX IF NOT EXISTS QUEUED_MESSAGES ON MESSAGES ( connection_id ASC, timestamp ASC )',
        ]
        await Promise.all(stmts.map(async (stmt) => await client.query(stmt)))
        logger.info(`Successfully created messages schema`)
      } finally {
        await client.end()
      }
    } catch (e) {
      logger.error('While creating messages schema', e)
      throw e
    }
  }

  public static admin_config(): Configuration | undefined {
    return {
      ...IPostgreSQLConfigToConfiguration(PostgreSQLMessageRepository.CONFIG),
      database: 'postgres',
      user: PostgreSQLMessageRepository.CONFIG?.admin_account,
      password: PostgreSQLMessageRepository.CONFIG?.admin_password,
    }
  }

  public static default_config(): Configuration | undefined {
    return IPostgreSQLConfigToConfiguration(PostgreSQLMessageRepository.CONFIG)
  }

  private logger: Logger
  private client: Client

  public constructor(@inject(InjectionSymbols.Logger) logger: Logger) {
    this.logger = logger
    this.client = new Client(PostgreSQLMessageRepository.default_config())
    this.connect()
  }

  private connect() {
    void (async () => await this.client.connect())()
  }

  public getAvailableMessageCount(options: GetAvailableMessageCountOptions): number | Promise<number> {
    return (async () => await this.asyncGetAvailableMessageCount(options))()
  }

  /* prepared statements are preferred but calling client.prepare with a where clause hangs, needs debugging */
  private async asyncGetAvailableMessageCount(options: GetAvailableMessageCountOptions): Promise<number> {
    const query = `SELECT COUNT(*) as message_count FROM MESSAGES WHERE connection_id = '${options.connectionId}'`
    const row = await this.client.query(query).first()
    const value = row?.get('message_count') as bigint
    return Number(value)
  }

  public takeFromQueue(options: TakeFromQueueOptions): QueuedMessage[] | Promise<QueuedMessage[]> {
    return (async () => await this.asyncTakeFromQueue(options))()
  }

  /* prepared statements are preferred but calling client.prepare with a where clause hangs, needs debugging */
  private async asyncTakeFromQueue(options: TakeFromQueueOptions): Promise<QueuedMessage[]> {
    const messagesToTake = options.limit ? options.limit : 'ALL'
    const query = `SELECT uuid, connection_id, payload FROM messages WHERE connection_id = '${options.connectionId}' ORDER BY timestamp ASC LIMIT ${messagesToTake}`
    this.logger.debug(
      // eslint-disable-next-line prettier/prettier
      `Taking ${messagesToTake} message(s) from queue for connection ${options.connectionId}, keeping them: ${!!options.keepMessages}`
    )
    const results = await this.client.query(query)
    const uuids: UUID[] = []
    const messages: QueuedMessage[] = []
    for await (const row of results) {
      const uuid = row.get('uuid')
      const payload = row.get('payload')
      if (uuid && payload) {
        uuids.push(uuid as UUID)
        const encryptedMessage = payload as unknown as EncryptedMessage
        messages.push({ id: uuid, encryptedMessage })
      }
    }
    if (!options.keepMessages) {
      const messageIds = uuids as string[]
      await this.removeMessages({ connectionId: options.connectionId, messageIds })
    }
    return messages
  }

  public addMessage(options: AddMessageOptions): string | Promise<string> {
    return (async () => this.asyncAddMessage(options))()
  }

  /* prepared statements are preferred but calling client.prepare with a where clause hangs, needs debugging */
  private async asyncAddMessage(options: AddMessageOptions): Promise<string> {
    const uuid = randomUUID()
    await this.client.query(`INSERT INTO MESSAGES (uuid, connection_id, payload) VALUES ( $1, $2, $3 )`, [
      uuid,
      options.connectionId,
      options.payload,
    ])
    return uuid
  }

  public removeMessages(options: RemoveMessagesOptions) {
    return (async () => this.asyncRemoveMessages(options))()
  }

  private async asyncRemoveMessages(options: RemoveMessagesOptions): Promise<void> {
    const values = options.messageIds.map((s: string) => "'" + s + "'").join(',')
    const query = `DELETE FROM MESSAGES WHERE uuid IN ( ${values} )`
    await this.client.query(query)
  }

  public static convertCDCMessage(message: string): Set<string> {
    const json = JSON.parse(message)
    const changes: object[] = json['change']
    const inserts = changes.filter(
      (obj: object) => obj['kind' as keyof typeof obj] === 'insert' && obj['table' as keyof typeof obj] === 'MESSAGES'
    )
    const connectionIds = inserts.map((insert: object) => {
      const columnnames: string[] = insert['columnnames' as keyof typeof insert] as string[]
      const columnvalues: string[] = insert['columnvalues' as keyof typeof insert] as string[]
      const idx = columnnames.findIndex((name: string) => name === 'connection_id')
      return columnvalues[idx] as string
    })
    return new Set(connectionIds)
  }
}
