// What server code needs from this package, without the browser-only device store: provider
// validation, redaction, the vault, the key-validation handler, and the audit checkpoint signer.
// Workers, Next route handlers, and @earshot/db import "@earshot/keys/server"; it typechecks
// without the DOM lib.
export {
  AUDIT_RETIRED_KEYS_ENV,
  AUDIT_SIGNING_ALG,
  AUDIT_SIGNING_KEY_ENV,
  AuditKeyError,
  type AuditPublicKey,
  type AuditSigner,
  type AuditSigningState,
  auditKeySecretValues,
  auditPublicKeys,
  type CheckpointClaims,
  type CheckpointVerdict,
  checkpointMessage,
  DEV_AUDIT_KID,
  DEV_AUDIT_SIGNING_KEY,
  fromBase64Url,
  fromHex,
  type GeneratedAuditKey,
  generateAuditSigningKey,
  loadAuditSigningKey,
  parseRetiredAuditKeys,
  type SignedCheckpoint,
  signCheckpoint,
  toBase64Url,
  toHex,
  verifyCheckpoint,
} from "./audit-signing";
export {
  type FetchLike,
  isProviderId,
  last4,
  PROVIDER_IDS,
  PROVIDERS,
  type Provider,
  type ProviderId,
  type ValidationFailure,
  type ValidationResult,
  validateKey,
} from "./providers";
export {
  containsSecret,
  createRedactingLogger,
  findSecretFragment,
  type Logger,
  type LogSink,
  PROVIDER_ID_HEADER,
  PROVIDER_KEY_HEADER,
  redact,
  redactValue,
  SECRET_PATTERNS,
} from "./redact";
export {
  handleValidateKey,
  type ValidateKeyOptions,
  type ValidateKeyReason,
  type ValidateKeyResponse,
} from "./validate-handler";
export {
  generateMasterKey,
  importMasterKey,
  loadVaultMasterKey,
  openSecret,
  rewrapSecret,
  type SealedSecret,
  sameMasterKey,
  sealSecret,
  VAULT_MASTER_KEY_ENV,
  vaultContext,
} from "./vault";
