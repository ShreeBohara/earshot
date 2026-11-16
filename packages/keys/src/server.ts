// What server code needs from this package, without the browser-only device store: provider
// validation, redaction, the vault, and the key-validation handler. Workers, Next route
// handlers, and @earshot/db import "@earshot/keys/server"; it typechecks without the DOM lib.
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
