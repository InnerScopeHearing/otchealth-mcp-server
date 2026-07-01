# infra/ — Gateway Infrastructure as Code

`gateway.bicep` is the reviewable source-of-truth for the `otchealth-mcp-gateway` Container App and the template the golden path is rolled out from to the other backend repos. `iac-validate.yml` compiles it (`bicep build`) on every PR that touches `infra/`.

## What it models (the TARGET posture)

It encodes the Layer-E hardening of the Azure AI OS design, which is a step **ahead** of the current live app:

- **System-assigned managed identity + AcrPull** — image pulls with no ACR admin username/password secret.
- **Secrets as Key Vault references** — GCP Secret Manager stays the store-of-record; Key Vault becomes the CI/CD-readable Azure mirror the app resolves with its managed identity.
- **Immutable `@sha256` image digest** (never a mutable tag) + **multiple-revision mode** for blue-green.

## Live vs. template (why it is not yet applied to prod)

The live gateway currently uses **ACR admin-password auth** (`acr-pwd` secret), **37 inline secrets**, and **`identity: None`**. Adopting the live app into a `denyWriteAndDelete` **Deployment Stack** from this template is a **gated migration**, not a blind apply, because a stack apply reconciles the live resource to the template and would mutate a running, keys-to-the-kingdom service. The safe order is:

1. Grant the app a system-assigned identity + **AcrPull** on the registry.
2. Migrate the 37 inline secrets to **Key Vault** and repoint them as `keyVaultUrl` secret refs.
3. `az deployment group what-if` against the live resource until the diff is **empty**.
4. Create the Deployment Stack with `denySettingsMode=denyWriteAndDelete` **excluding the CI deploy identity** (via an Entra group, max 5 principals) so no human/agent can hand-mutate prod but the pipeline still can.

Until that migration lands, prod is protected by a **`CanNotDelete` management lock** on the container app (prevents accidental deletion; still allows the pipeline's revision updates), and by branch-protection + OIDC-only deploys.

## Deploy (once params are supplied)

```
az deployment group create -g rg-otchealth-apps-prod -f infra/gateway.bicep \
  -p managedEnvironmentId=<env-id> acrLoginServer=acrotc55c84f6bef.azurecr.io image=<acr>/otchealth-mcp-server@sha256:<digest> \
     plainEnv=@plain.json secretEnv=@secret.json secretRefs=@kvrefs.json
```
