export { createHttpDb, createPoolDb, type HttpDb, type PoolDb } from "./client";
export { type DbHealth, readDbHealth, stampBranch } from "./health";
export * as schema from "./schema";
export {
  resolveWorkspace,
  TENANT_ROLE,
  type TenantContext,
  tenantTables,
  withTenant,
} from "./tenant";
export {
  type CredentialMeta,
  type CredentialSlot,
  credentialContext,
  crmConnectionContext,
  deleteCredential,
  listCredentials,
  type PutCredentialInput,
  putCredential,
  revealCredential,
  VaultOffError,
  VaultOpenError,
} from "./vault";
export { type RotationReport, rotateVaultKey, VaultRotationError } from "./vault-rotation";
