// ============================================================================
// otchealth-mcp-gateway, Azure API Management (Infrastructure as Code)
//
// This is the reviewable source-of-truth for the ALREADY-PROVISIONED APIM instance sitting
// between Front Door and the Container App: the service itself, the mcp-gateway API (root path,
// forwarding to the Container App ingress), the product ai-gateway-agents, and the per-caller
// rate-limit + daily-quota policy keyed on the inbound bearer token.
//
// This file is for `bicep build` compile validation + drift visibility (iac-validate.yml already
// globs infra/*.bicep). It is NOT deployed by this PR, see frontdoor.bicep's header for the same
// note; the live topology (this file + frontdoor.bicep) is adopted into IaC-managed state as a
// separate, deliberate CTO step once reviewed.
//
// Topology (matches the live resources):
//   service (apim-otc-55c84f6b, BasicV2)
//     -> api (mcp-gateway, path '', serviceUrl = the Container App ingress)
//          -> policy (rate-limit-by-key 1000/60s + quota-by-key 200000/86400s, both keyed on the
//                     inbound Authorization bearer)
//     -> product (ai-gateway-agents, subscriptionRequired=false) <-> api (product/api link)
// ============================================================================

@description('APIM service (instance) name.')
param serviceName string = 'apim-otc-55c84f6b'

@description('Azure region for the APIM service.')
param location string = resourceGroup().location

@description('APIM SKU. BasicV2 matches the live instance (a low-cost, always-on tier with the classic v2 gateway).')
@allowed([
  'BasicV2'
  'StandardV2'
  'PremiumV2'
])
param skuName string = 'BasicV2'

@description('APIM SKU capacity (scale units).')
param skuCapacity int = 1

@description('Publisher email required by the ApiManagement/service resource.')
param publisherEmail string = 'matthew@otchealth.app'

@description('Publisher/organization name required by the ApiManagement/service resource.')
param publisherName string = 'OTCHealth Inc.'

@description('The mcp-gateway API resource name.')
param apiName string = 'mcp-gateway'

@description('Backend serviceUrl the mcp-gateway API forwards to: the otchealth-mcp-gateway Container App ingress FQDN, e.g. https://otchealth-mcp-gateway.<env-suffix>.azurecontainerapps.io')
param gatewayBackendUrl string

@description('Product resource name.')
param productName string = 'ai-gateway-agents'

@description('Per-key rate limit: max calls in the renewal window.')
param rateLimitCalls int = 1000

@description('Per-key rate limit renewal window, in seconds.')
param rateLimitRenewalPeriodSeconds int = 60

@description('Per-key daily quota: max calls in the renewal window.')
param quotaCalls int = 200000

@description('Per-key daily quota renewal window, in seconds (86400 = 24h).')
param quotaRenewalPeriodSeconds int = 86400

resource service 'Microsoft.ApiManagement/service@2023-09-01-preview' = {
  name: serviceName
  location: location
  sku: {
    name: skuName
    capacity: skuCapacity
  }
  identity: {
    // System-assigned identity available for future Key Vault-backed named values / backend auth,
    // matching the same managed-identity-over-static-secret posture as gateway.bicep.
    type: 'SystemAssigned'
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
  }
}

resource api 'Microsoft.ApiManagement/service/apis@2023-09-01-preview' = {
  parent: service
  name: apiName
  properties: {
    displayName: 'OTCHealth MCP Gateway'
    // Root path: APIM forwards the whole https://apim-otc-55c84f6b.azure-api.net/* surface
    // straight through to the Container App (the gateway owns its own /mcp, /health, /oauth/*
    // routing internally).
    path: ''
    protocols: [
      'https'
    ]
    serviceUrl: gatewayBackendUrl
    // The gateway does its own bearer-token auth (PERPLEXITY_CONNECTOR_TOKEN / issued OAuth
    // tokens); APIM does not additionally gate on an APIM subscription key.
    subscriptionRequired: false
  }
}

// Rate-limit-by-key (1000 calls / 60s) + quota-by-key (200000 calls / 86400s), both keyed on the
// caller's inbound bearer token so limits are per-CALLER, not shared across every agent hitting
// the gateway through this one APIM instance. counter-key is a policy expression, never a literal
// secret value; APIM stores only the derived counter, not the token itself.
//
// Bicep's ''' multiline string is a RAW/verbatim literal (it does not interpolate ${...}), so the
// numeric values are substituted with format()'s {n} placeholders instead. The counter-key policy
// expression's own GetValueOrDefault("Authorization","") call needs literal double quotes, which
// would otherwise collide with the XML attribute's own double-quote delimiters; the attribute is
// single-quote-delimited (counter-key='...') to sidestep that entirely, which is valid per the XML
// spec (either quote character may delimit an attribute value) and needs no escaping in Bicep.
var apiPolicyXml = format('''
<policies>
  <inbound>
    <base />
    <rate-limit-by-key calls="{0}" renewal-period="{1}" counter-key='@(context.Request.Headers.GetValueOrDefault("Authorization",""))' />
    <quota-by-key calls="{2}" renewal-period="{3}" counter-key='@(context.Request.Headers.GetValueOrDefault("Authorization",""))' />
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
  <on-error>
    <base />
  </on-error>
</policies>
''', rateLimitCalls, rateLimitRenewalPeriodSeconds, quotaCalls, quotaRenewalPeriodSeconds)

resource apiPolicy 'Microsoft.ApiManagement/service/apis/policies@2023-09-01-preview' = {
  parent: api
  name: 'policy'
  properties: {
    format: 'xml'
    value: apiPolicyXml
  }
}

resource product 'Microsoft.ApiManagement/service/products@2023-09-01-preview' = {
  parent: service
  name: productName
  properties: {
    displayName: 'AI Gateway Agents'
    description: 'The single custom MCP surface every AI client (Claude, Hyperagent, Copilot) connects through.'
    subscriptionRequired: false
    state: 'published'
  }
}

resource productApi 'Microsoft.ApiManagement/service/products/apis@2023-09-01-preview' = {
  parent: product
  name: api.name
}

output serviceId string = service.id
output gatewayHostName string = service.properties.gatewayUrl
