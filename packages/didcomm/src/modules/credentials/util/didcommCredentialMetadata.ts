import type { DidCommRevocationNotification } from '../models'

/**
 * Metadata key for strong metadata on a credential received through DIDComm.
 *
 * MUST be used with {@link W3cDidCommCredentialMetadata}
 */
export const W3cDidCommCredentialMetadataKey = '_didcomm/credential'

export interface W3cDidCommCredentialMetadata {
  connectionId?: string
  revocationNotification?: DidCommRevocationNotification
}
