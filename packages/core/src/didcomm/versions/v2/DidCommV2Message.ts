import type { PlaintextDidCommV2Message } from './types'
import type { AgentBaseMessage } from '../../../agent/AgentBaseMessage'
import type { ServiceDecorator } from '../../../decorators/service/ServiceDecorator'
import type { PlaintextMessage } from '../../types'

import { AriesFrameworkError } from '../../../error'
import { JsonTransformer } from '../../../utils/JsonTransformer'
import { DidCommMessageVersion } from '../../types'

import { DidCommV2BaseMessage } from './DidCommV2BaseMessage'
import { DidCommV1Message } from '../v1'

export class DidCommV2Message extends DidCommV2BaseMessage implements AgentBaseMessage {
  public get didCommVersion(): DidCommMessageVersion {
    return DidCommMessageVersion.V2
  }

  public toDidcommV1(): DidCommV1Message {
    // Apply mapping from https://github.com/decentralized-identity/didcomm-book/blob/main/docs/migratorscript.md
    const message = new DidCommV1Message()
    message.id = this.id
    message.type = this.type
    message.setThread({ parentThreadId: this.parentThreadId, threadId: this.threadId })
    

    return message
  }

  public toJSON(params: {
    useDidSovPrefixWhereAllowed?: boolean
    convertToDidcommVersion?: DidCommMessageVersion
  }): PlaintextMessage {
    const didcommMessage = params.convertToDidcommVersion === DidCommMessageVersion.V1 ? this.toDidcommV1() : this
    return JsonTransformer.toJSON(didcommMessage) as PlaintextDidCommV2Message
  }

  public serviceDecorator(): ServiceDecorator | undefined {
    return undefined
  }

  public get threadId(): string | undefined {
    return this.thid
  }

  public hasAnyReturnRoute() {
    return false
  }

  public hasReturnRouting() {
    return false
  }

  public setReturnRouting(): void {
    throw new AriesFrameworkError('DidComm V2 message does not provide `setReturnRouting` method')
  }

  public is<C extends typeof DidCommV2Message>(Class: C): this is InstanceType<C> {
    return this.type === Class.type.messageTypeUri
  }

  public get firstRecipient(): string | undefined {
    return this.to?.length ? this.to[0] : undefined
  }
}
