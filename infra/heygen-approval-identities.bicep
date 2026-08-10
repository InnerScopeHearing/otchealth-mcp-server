targetScope = 'resourceGroup'

param location string = resourceGroup().location
param brokerIdentityName string = 'id-heygen-approval-broker'
param gatewayIdentityName string = 'id-heygen-approval-gateway'

resource brokerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: brokerIdentityName
  location: location
}

resource gatewayIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: gatewayIdentityName
  location: location
}

output brokerIdentityResourceId string = brokerIdentity.id
output brokerPrincipalId string = brokerIdentity.properties.principalId
output gatewayIdentityResourceId string = gatewayIdentity.id
output gatewayPrincipalId string = gatewayIdentity.properties.principalId
