import { getAgentConfig } from '../../../tests/helpers'

describe('AgentConfig', () => {
  describe('endpoints', () => {
    it('should return the config endpoint if no inbound connection is available', () => {
      const endpoint = 'https://local-url.com'

      const agentConfig = getAgentConfig('AgentConfig Test', {
        endpoints: [endpoint],
      })

      expect(agentConfig.endpoints).toEqual([endpoint])
    })

    it("should return ['didcomm:transport/queue'] if no inbound connection or config endpoint or host/port is available", () => {
      const agentConfig = getAgentConfig('AgentConfig Test')

      expect(agentConfig.endpoints).toStrictEqual(['didcomm:transport/queue'])
    })

    it('should return the new config endpoint after setter is called', () => {
      const endpoint = 'https://local-url.com'
      const newEndpoint = 'https://new-local-url.com'

      const agentConfig = getAgentConfig('AgentConfig Test', {
        endpoints: [endpoint],
      })

      agentConfig.endpoints = [newEndpoint]
      expect(agentConfig.endpoints).toEqual([newEndpoint])
    })
  })
)
