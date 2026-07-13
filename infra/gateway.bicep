// ============================================================================
// otchealth-mcp-gateway — Container App (Infrastructure as Code)
//
// This is the reviewable source-of-truth for the gateway's Azure shape AND the
// template the golden path is rolled out from to the other backend repos.
//
// It models the TARGET posture (Layer E of the Azure AI OS design), which is a
// hardening over the current live app:
//   - system-assigned managed identity + AcrPull  (no ACR admin password secret)
//   - secrets as Key Vault references              (GCP Secret Manager stays store-of-record;
//                                                    Key Vault is the CI/CD-readable Azure mirror)
//   - immutable @sha256 image digest, never a tag
//   - blue-green: multiple-revision mode + git-sha revision suffix
//
// Adopting the LIVE app into a Deployment Stack from this template is a separate,
// gated migration (it requires moving the 37 inline secrets to Key Vault + granting
// the managed identity first); see infra/README.md. `bicep build` validates this in CI.
// ============================================================================

@description('Azure region (must match the managed environment).')
param location string = resourceGroup().location

@description('Resource id of the existing Container Apps managed environment.')
param managedEnvironmentId string

@description('Container app name.')
param appName string = 'otchealth-mcp-gateway'

@description('ACR login server, e.g. acrotc55c84f6bef.azurecr.io')
param acrLoginServer string

@description('Full immutable image reference, e.g. <acr>/otchealth-mcp-server@sha256:...')
param image string

@description('Ingress target port.')
param targetPort int = 8080

@minValue(1)
param minReplicas int = 2
@minValue(1)
param maxReplicas int = 10

@description('HTTP concurrent-requests per replica that triggers scale-out (§6c capacity fix).')
param httpConcurrentRequests int = 30

param cpu string = '1.0'
param memory string = '2Gi'

@description('Non-secret environment variables: [{ name, value }].')
param plainEnv array = []

@description('Secret-backed env: [{ name, secretRef }] where secretRef names an entry in secretRefs.')
param secretEnv array = []

@description('Secrets as Key Vault references: [{ name, keyVaultUrl }]. Resolved by the managed identity.')
param secretRefs array = []

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    // System-assigned identity: used for AcrPull (image pulls) + Key Vault secret resolution.
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Multiple'
      ingress: {
        external: true
        targetPort: targetPort
        transport: 'Auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          // Pull with the app's managed identity (AcrPull), not an admin username/password secret.
          identity: 'system'
        }
      ]
      secrets: [
        for s in secretRefs: {
          name: s.name
          keyVaultUrl: s.keyVaultUrl
          identity: 'system'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'gateway'
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          // plainEnv = [{ name, value }], secretEnv = [{ name, secretRef }]; both are valid env entries.
          env: concat(plainEnv, secretEnv)
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        // §6c (2026-07-13): explicit concurrency rule so the app scales out under load instead of
        // relying on the implicit default 10-concurrent scaler capped at maxReplicas (the 2026-07-07
        // 7/7 outage cause at ~120 concurrent). deploy.yml sets the same values on each image update.
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: string(httpConcurrentRequests)
              }
            }
          }
        ]
      }
    }
  }
}

output principalId string = app.identity.principalId
output fqdn string = app.properties.configuration.ingress.fqdn
