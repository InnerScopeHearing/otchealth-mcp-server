targetScope = 'resourceGroup'

// Deploy this template to rg-otchealth-shared-prod; identities remain in the apps resource group.
param appsResourceGroupName string = 'rg-otchealth-apps-prod'
param registryName string = 'acrotc55c84f6bef'
param keyVaultName string = 'kv-otc-55c84f6bef'
param brokerIdentityName string = 'id-heygen-approval-broker'
param gatewayIdentityName string = 'id-heygen-approval-gateway'

var keyVaultSecretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var acrPullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource brokerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: brokerIdentityName
  scope: resourceGroup(appsResourceGroupName)
}
resource gatewayIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: gatewayIdentityName
  scope: resourceGroup(appsResourceGroupName)
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
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

resource brokerAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: 'a12aab40-9e79-53d8-a0e2-5705ff05bd93'
  scope: registry
  properties: {
    roleDefinitionId: acrPullRole
    principalId: brokerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource brokerPrivateRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: 'e5688811-4796-517c-83a2-9a94050e41b4'
  scope: privateJwk
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: brokerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource brokerPublicRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: 'b512caac-984d-51b1-aa9c-7cd989028c3e'
  scope: publicJwk
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: brokerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource brokerContextRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: '26f59d62-f491-512b-ae72-43a414d8238a'
  scope: contextSecret
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: brokerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource brokerHandleRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: '2e61ff7c-2295-5367-aa71-d9ad956d7396'
  scope: handleSecret
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: brokerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource brokerCallbackRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: 'aa4b2c1f-18ab-5b5a-9e77-00129d3c9c83'
  scope: callbackSecret
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: brokerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource gatewayPublicRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: '2df54a0b-7bdf-51e6-8490-abfc961b5e79'
  scope: publicJwk
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: gatewayIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource gatewayContextRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: '3319e69c-a9d1-5671-a8e9-096cbb98072d'
  scope: contextSecret
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: gatewayIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource gatewayHandleRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: 'd29a4051-3ded-572f-9a07-da913d7e7056'
  scope: handleSecret
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: gatewayIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource gatewayCallbackRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: '4eb6eb18-0b98-547e-b07a-0db00161fc78'
  scope: callbackSecret
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: gatewayIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
