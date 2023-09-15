import type { V2BasicMessageOptions } from './V2BasicMessageOptions'

import { Expose, Transform } from 'class-transformer'
import { IsDate, IsString } from 'class-validator'

import { DidCommV1Message } from '../../../../../didcomm'
import { IsValidMessageType, parseMessageType } from '../../../../../utils/messageType'
import { DateParser } from '../../../../../utils/transformers'

export class V2BasicMessageDidCommV1 extends DidCommV1Message {
  public readonly allowDidSovPrefix = true

  public constructor(options: V2BasicMessageOptions) {
    super()

    if (options) {
      this.id = options.id || this.generateId()
      this.sentTime = options.sentTime || new Date()
      this.content = options.content
      this.addLocale(options.locale || 'en')
    }
  }

  @IsValidMessageType(V2BasicMessageDidCommV1.type)
  public readonly type = V2BasicMessageDidCommV1.type.messageTypeUri
  public static readonly type = parseMessageType('https://didcomm.org/basicmessage/2.0/message')

  @Expose({ name: 'sent_time' })
  @Transform(({ value }) => DateParser(value))
  @IsDate()
  public sentTime!: Date

  @Expose({ name: 'content' })
  @IsString()
  public content!: string
}
