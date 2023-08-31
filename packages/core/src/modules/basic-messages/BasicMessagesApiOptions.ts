import type { BasicMessageProtocol } from './protocols'

/**
 * Get the supported protocol versions based on the provided discover features services.
 */
export type BasicMessagesProtocolVersionType<BMPs extends BasicMessageProtocol[]> = BMPs[number]['version']

interface BaseOptions {
  connectionId: string
}

export interface SendMessageOptions<BMPs extends BasicMessageProtocol[] = BasicMessageProtocol[]> extends BaseOptions {
  protocolVersion: BasicMessagesProtocolVersionType<BMPs>
  connectionId: string
  message: string
  parentThreadId?: string
}
