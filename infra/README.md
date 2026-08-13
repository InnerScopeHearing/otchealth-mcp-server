# infra/ — Gateway Infrastructure as Code

`gateway.bicep` is the reviewable source-of-truth for the `otchealth-mcp-gateway` Container App and the template the golden path is rolled out from to the other backend repos. `iac-validate.yml` compiles it (`bicep build`) on every PR that touches `infra/`.

## What it models (the TARGET posture)

It encodes the Layer-E hardening of the Azure AI OS design, which is still partly ahead of the current live app:

- **System-assigned managed identity + AcrPull** — image pulls with no ACR admin username/password secret.
- **Secrets as Azure Key Vault references** — GCP is permanently retired. Scoped user-assigned identities can resolve dedicated references without widening access to unrelated secrets.
- **Immutable `@sha256` image digest** (never a mutable tag) + **multiple-revision mode** for blue-green.

## Live vs. template (why it is not yet applied to prod)

The live gateway now has a system identity plus the secret-scoped `id-heygen-approval-gateway` user identity, but it still retains legacy ACR admin-password auth and many inline secrets. Adopting the full app into a `denyWriteAndDelete` **Deployment Stack** remains a gated migration, not a blind apply, because a stack apply reconciles the live resource to the template and would mutate a running, keys-to-the-kingdom service. The safe order is:

1. Grant the system identity **AcrPull** and switch registry auth off the legacy password.
2. Migrate remaining inline secrets to **Azure Key Vault** and repoint them as `keyVaultUrl` secret refs.
3. `az deployment group what-if` against the live resource until the diff is **empty**.
4. Create the Deployment Stack with `denySettingsMode=denyWriteAndDelete` **excluding the CI deploy identity** (via an Entra group, max 5 principals) so no human/agent can hand-mutate prod but the pipeline still can.

Until that migration lands, prod is protected by a **`CanNotDelete` management lock** on the container app (prevents accidental deletion; still allows the pipeline's revision updates), and by branch-protection + OIDC-only deploys.

## Deploy (once params are supplied)

```
az deployment group create -g rg-otchealth-apps-prod -f infra/gateway.bicep \
  -p managedEnvironmentId=<env-id> acrLoginServer=acrotc55c84f6bef.azurecr.io image=<acr>/otchealth-mcp-server@sha256:<digest> \
     plainEnv=@plain.json secretEnv=@secret.json secretRefs=@kvrefs.json
```

## HeyGen owner-approval boundary

The clean bootstrap order is: (1) deploy `heygen-approval-identities.bicep` to `rg-otchealth-apps-prod`; (2) deploy `heygen-approval-rbac.bicep` to `rg-otchealth-shared-prod`; (3) deploy `heygen-approval.bicep` to `rg-otchealth-apps-prod`. This prevents the broker from trying to pull its image or resolve Key Vault references before permissions exist. The broker template captures the immutable image input, command, and one-replica scale; the RBAC template captures secret-level Key Vault reads plus AcrPull. The broker identity can read the private JWK; the gateway verifier identity cannot. The production deploy workflow updates and health-gates the broker before it creates the gateway candidate revision.
