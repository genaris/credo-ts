import type { DocumentLoaderWithContext } from './data-integrity/libraries/documentLoader'

import { defaultDocumentLoader } from './data-integrity/libraries/documentLoader'

/**
 * W3cCredentialsModuleConfigOptions defines the interface for the options of the W3cCredentialsModuleConfig class.
 * This can contain optional parameters that have default values in the config class itself.
 */
export interface W3cCredentialsModuleConfigOptions {
  /**
   * Document loader to use for resolving JSON-LD objects. Takes a {@link AgentContext} as parameter,
   * and must return a {@link DocumentLoader} function.
   *
   * @example
   * ```
   * const myDocumentLoader = (agentContext: AgentContext) => {
   *   return async (url) => {
   *     if (url !== 'https://example.org') throw new Error("I don't know how to load this document")
   *
   *     return {
   *       contextUrl: null,
   *       documentUrl: url,
   *       document: null
   *     }
   *   }
   * }
   * ```
   *
   *
   * @default {@link defaultDocumentLoader}
   */
  documentLoader?: DocumentLoaderWithContext

  /**
   * Extra JSON-LD contexts to preload alongside the default ones shipped with Credo.
   * These are checked before any network request, providing a performance benefit for
   * frequently used contexts. If a URL matches both a default and an extra context,
   * the extra context takes precedence.
   *
   * @example
   * ```
   * extraJsonLdContexts: {
   *   'https://example.org/my-context/v1': { '@context': { /* ... *\/ } },
   * }
   * ```
   *
   * @note Only used when the default document loader is active (i.e. no custom `documentLoader` is set).
   */
  extraJsonLdContexts?: Record<string, Record<string, unknown>>
}

export class W3cCredentialsModuleConfig {
  private options: W3cCredentialsModuleConfigOptions

  public constructor(options?: W3cCredentialsModuleConfigOptions) {
    this.options = options ?? {}
  }

  /** See {@link W3cCredentialsModuleConfigOptions.documentLoader} */
  public get documentLoader(): DocumentLoaderWithContext {
    if (this.options.documentLoader) return this.options.documentLoader

    const extraJsonLdContexts = this.options.extraJsonLdContexts
    return (agentContext) => defaultDocumentLoader(agentContext, extraJsonLdContexts)
  }
}
