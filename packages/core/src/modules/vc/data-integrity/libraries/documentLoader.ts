import type { AgentContext } from '../../../../agent/context/AgentContext'
import { CredoError } from '../../../../error/CredoError'
import { isDid } from '../../../../utils'
import { DidResolverService } from '../../../dids'
import { DEFAULT_CONTEXTS } from './contexts'
import type { DocumentLoader } from './jsonld'
import jsonld from './jsonld'
import { getNativeDocumentLoader } from './nativeDocumentLoader'

export type DocumentLoaderWithContext = (agentContext: AgentContext) => DocumentLoader

export function defaultDocumentLoader(
  agentContext: AgentContext,
  extraContexts?: Record<string, Record<string, unknown>>
): DocumentLoader {
  const didResolver = agentContext.dependencyManager.resolve(DidResolverService)
  const allContexts: Record<string, Record<string, unknown>> = { ...DEFAULT_CONTEXTS, ...extraContexts }

  async function loader(url: string) {
    // Check if in the default or extra preloaded contexts
    if (url in allContexts) {
      return {
        contextUrl: null,
        documentUrl: url,
        document: allContexts[url],
      }
    }

    const withoutFragment = url.split('#')[0]
    if (withoutFragment in allContexts) {
      return {
        contextUrl: null,
        documentUrl: url,
        document: allContexts[withoutFragment],
      }
    }

    if (isDid(url)) {
      const result = await didResolver.resolve(agentContext, url)

      if (result.didResolutionMetadata.error || !result.didDocument) {
        throw new CredoError(`Unable to resolve DID: ${url}`)
      }

      const framed = await jsonld.frame(
        result.didDocument.toJSON(),
        {
          '@context': result.didDocument.context,
          '@embed': '@never',
          id: url,
        },
        // @ts-expect-error
        { documentLoader: this }
      )

      return {
        contextUrl: null,
        documentUrl: url,
        document: framed,
      }
    }

    // fetches the documentLoader from documentLoader.ts or documentLoader.native.ts depending on the platform at bundle time
    const platformLoader = await getNativeDocumentLoader()
    const nativeLoader = platformLoader.apply(jsonld, [])

    return await nativeLoader(url)
  }

  return loader.bind(loader)
}
