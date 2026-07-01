// ============================================================================
// otchealth-mcp-gateway, Azure Front Door (Standard/Premium) + WAF (Infrastructure as Code)
//
// This is the reviewable source-of-truth for the ALREADY-PROVISIONED Front Door profile that
// fronts the gateway (the AI OS Layer E network edge): the Front Door profile, endpoint, origin
// group pointed at APIM, the route, the custom domain mcp.otchealth.app, and a NEW WAF policy in
// Detection (log-only, non-blocking) mode.
//
// This file is for `bicep build` compile validation and drift visibility (iac-validate.yml
// already globs infra/*.bicep). It is NOT deployed by this PR: adopting the live profile into a
// Deployment Stack from this template is a separate, gated migration, matching the posture
// gateway.bicep already documents for the Container App. Attaching the NEW WAF policy to the
// live endpoint is likewise a deliberate follow-on `az deployment group create` / portal step by
// the CTO, done once this template is reviewed, not an automatic side effect of merging this PR.
//
// Topology (matches the live resources):
//   profile (afd-otchealth, Premium_AzureFrontDoor)
//     -> afdEndpoint (gw-ep)
//          -> route (gw-route) -> originGroup (apim-og) -> origin (apim, the APIM gateway host)
//          -> customDomain (mcp-otchealth-app, hostName mcp.otchealth.app, ManagedCertificate)
//     -> securityPolicy (gw-security-policy) associates the WAF policy with the endpoint + domain
//   frontdoorWebApplicationFirewallPolicy (wafotchealthgw), Detection mode, Microsoft_DefaultRuleSet 1.1
// ============================================================================

@description('Front Door profile name.')
param profileName string = 'afd-otchealth'

@description('Front Door SKU. Standard_AzureFrontDoor or Premium_AzureFrontDoor (Premium required for the managed WAF rule sets used here).')
@allowed([
  'Standard_AzureFrontDoor'
  'Premium_AzureFrontDoor'
])
param profileSku string = 'Premium_AzureFrontDoor'

@description('Front Door endpoint name (the gw-ep front door edge hostname).')
param endpointName string = 'gw-ep'

@description('Origin group name fronting APIM.')
param originGroupName string = 'apim-og'

@description('APIM gateway hostname this origin group forwards to, e.g. apim-otc-55c84f6b.azure-api.net.')
param apimHostName string = 'apim-otc-55c84f6b.azure-api.net'

@description('Custom domain resource name (Azure resource name, not the hostname itself).')
param customDomainResourceName string = 'mcp-otchealth-app'

@description('The public hostname served through this custom domain.')
param customDomainHostName string = 'mcp.otchealth.app'

@description('WAF policy resource name. MUST be alphanumeric only: Front Door WAF policy names reject hyphens ("Policy ArmResourceId has incorrect formatting"), so this matches the live-attached policy name exactly.')
param wafPolicyName string = 'wafotchealthgw'

@description('WAF mode. Detection = log-only, never blocks traffic. Do not flip to Prevention from this template without a deliberate, reviewed change (a bad WAF rule in Prevention mode can 403 legitimate MCP traffic).')
@allowed([
  'Detection'
  'Prevention'
])
param wafMode string = 'Detection'

@description('Managed rule set version for Microsoft_DefaultRuleSet. 1.1 is what the live policy uses: version 2.1 returns "rule set action value is not supported" (400) at api 2024-02-01, so this matches the deployed WAF.')
param defaultRuleSetVersion string = '1.1'

resource profile 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: profileName
  location: 'global'
  sku: {
    name: profileSku
  }
}

resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: profile
  name: endpointName
  location: 'global'
  properties: {
    enabledState: 'Enabled'
  }
}

resource originGroup 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = {
  parent: profile
  name: originGroupName
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    healthProbeSettings: {
      probePath: '/health'
      probeRequestType: 'GET'
      probeProtocol: 'Https'
      probeIntervalInSeconds: 100
    }
  }
}

resource origin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = {
  parent: originGroup
  name: 'apim'
  properties: {
    hostName: apimHostName
    httpPort: 80
    httpsPort: 443
    originHostHeader: apimHostName
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
  }
}

resource customDomain 'Microsoft.Cdn/profiles/customDomains@2024-02-01' = {
  parent: profile
  name: customDomainResourceName
  properties: {
    hostName: customDomainHostName
    tlsSettings: {
      certificateType: 'ManagedCertificate'
      minimumTlsVersion: 'TLS12'
    }
  }
}

resource route 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: endpoint
  name: 'gw-route'
  // origins must exist before a route can reference their parent origin group.
  dependsOn: [
    origin
  ]
  properties: {
    originGroup: {
      id: originGroup.id
    }
    customDomains: [
      {
        id: customDomain.id
      }
    ]
    supportedProtocols: [
      'Https'
    ]
    patternsToMatch: [
      '/*'
    ]
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
    httpsRedirect: 'Enabled'
  }
}

// NEW: the WAF policy this PR adds. Detection mode = every managed-rule match is LOGGED only;
// nothing is blocked. This is the safe first step (visibility before enforcement); flipping to
// Prevention is a deliberate, separately-reviewed change, never a silent side effect of this PR.
resource wafPolicy 'Microsoft.Network/frontdoorWebApplicationFirewallPolicies@2024-02-01' = {
  name: wafPolicyName
  location: 'global'
  sku: {
    name: profileSku
  }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: wafMode
    }
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'Microsoft_DefaultRuleSet'
          ruleSetVersion: defaultRuleSetVersion
        }
      ]
    }
  }
}

// Associates the WAF policy with the endpoint's default domain AND the custom domain, over the
// whole route surface ('/*'), so every request the gateway receives through Front Door is
// evaluated (log-only in Detection mode).
resource securityPolicy 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = {
  parent: profile
  name: 'gw-security-policy'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: {
        id: wafPolicy.id
      }
      associations: [
        {
          domains: [
            {
              id: customDomain.id
            }
            {
              id: endpoint.id
            }
          ]
          patternsToMatch: [
            '/*'
          ]
        }
      ]
    }
  }
}

output profileId string = profile.id
output endpointHostName string = endpoint.properties.hostName
output wafPolicyId string = wafPolicy.id
