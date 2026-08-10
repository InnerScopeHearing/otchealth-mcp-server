targetScope = 'resourceGroup'

@description('Immutable gateway image reference, preferably repository@sha256:digest.')
param image string
param location string = resourceGroup().location
param managedEnvironmentName string = 'cae-otchealth-apps'
param sharedResourceGroupName string = 'rg-otchealth-shared-prod'
param registryName string = 'acrotc55c84f6bef'
param keyVaultName string = 'kv-otc-55c84f6bef'
param brokerAppName string = 'otchealth-approval-broker'
param descopeProjectId string
param ownerEmail string
param approvalIssuer string = 'https://approval.otchealth.app'
param approvalAudience string = 'otchealth-heygen'
param gatewayCallbackUrl string = 'https://mcp.otchealth.app/heygen/approval/callback'

var brokerIdentityName = 'id-heygen-approval-broker'
var gatewayIdentityName = 'id-heygen-approval-gateway'

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: managedEnvironmentName
}

resource brokerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: brokerIdentityName
}

resource gatewayIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: gatewayIdentityName
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
  scope: resourceGroup(sharedResourceGroupName)
}

resource privateJwk 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: 'heygen-approval-private-jwk'
}
resource publicJwk 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: 'heygen-approval-public-jwk'
}
resource contextSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: 'heygen-approval-context-secret'
}
resource handleSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: 'heygen-approval-handle-secret'
}
resource callbackSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: 'heygen-approval-callback-secret'
}

resource broker 'Microsoft.App/containerApps@2024-03-01' = {
  name: brokerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${brokerIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Multiple'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: '${registryName}.azurecr.io'
          identity: brokerIdentity.id
        }
      ]
      secrets: [
        { name: 'approval-private-jwk', keyVaultUrl: privateJwk.properties.secretUri, identity: brokerIdentity.id }
        { name: 'approval-public-jwk', keyVaultUrl: publicJwk.properties.secretUri, identity: brokerIdentity.id }
        { name: 'approval-context', keyVaultUrl: contextSecret.properties.secretUri, identity: brokerIdentity.id }
        { name: 'approval-handle', keyVaultUrl: handleSecret.properties.secretUri, identity: brokerIdentity.id }
        { name: 'approval-callback', keyVaultUrl: callbackSecret.properties.secretUri, identity: brokerIdentity.id }
      ]
    }
    template: {
      containers: [{
        name: 'approval-broker'
        image: image
        command: ['node', 'dist/server/approval-broker-index.js']
        resources: {
          cpu: json('0.25')
          memory: '0.5Gi'
        }
        env: [
          { name: 'PORT', value: '8080' }
          { name: 'DESCOPE_PROJECT_ID', value: descopeProjectId }
          { name: 'HEYGEN_OWNER_APPROVAL_ISSUER', value: approvalIssuer }
          { name: 'HEYGEN_OWNER_APPROVAL_AUDIENCE', value: approvalAudience }
          { name: 'HEYGEN_OWNER_APPROVAL_SUBJECT', value: ownerEmail }
          { name: 'HEYGEN_OWNER_APPROVAL_EMAIL', value: ownerEmail }
          { name: 'HEYGEN_OWNER_APPROVAL_PRIVATE_JWK', secretRef: 'approval-private-jwk' }
          { name: 'HEYGEN_OWNER_APPROVAL_PUBLIC_JWK', secretRef: 'approval-public-jwk' }
          { name: 'HEYGEN_APPROVAL_CONTEXT_SECRET', secretRef: 'approval-context' }
          { name: 'HEYGEN_APPROVAL_HANDLE_SECRET', secretRef: 'approval-handle' }
          { name: 'HEYGEN_APPROVAL_CALLBACK_SECRET', secretRef: 'approval-callback' }
          { name: 'HEYGEN_APPROVAL_CALLBACK_URL', value: gatewayCallbackUrl }
        ]
      }]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output brokerUrl string = 'https://${broker.properties.configuration.ingress.fqdn}'
output brokerIdentityResourceId string = brokerIdentity.id
output gatewayVerifierIdentityResourceId string = gatewayIdentity.id
