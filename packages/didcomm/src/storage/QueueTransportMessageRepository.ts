import type {
  AddMessageOptions,
  GetAvailableMessageCountOptions,
  RemoveMessagesOptions,
  TakeFromQueueOptions,
} from './QueueTransportMessageRepositoryOptions'
import type { QueuedMessage } from './QueuedMessage'

export interface QueueTransportMessageRepository {
  getAvailableMessageCount(options: GetAvailableMessageCountOptions): number | Promise<number>
  takeFromQueue(options: TakeFromQueueOptions): QueuedMessage[] | Promise<QueuedMessage[]>
  addMessage(options: AddMessageOptions): string | Promise<string>
  removeMessages(options: RemoveMessagesOptions): void | Promise<void>
}
