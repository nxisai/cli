/**
 * Library surface.
 *
 * @remarks
 * The CLI is the product; this module exposes the same pieces so tests and programmatic
 * callers can use them without shelling out.
 */

export { resolveConfig, PRODUCTION_ENDPOINTS, ENDPOINT_ENV_VARS, singleHost } from "./config.js";
export type { Config, Endpoints } from "./config.js";
export { CliError, ExitCode, needsUser, notAuthorized, failed } from "./errors.js";
export { decodeJwt, accountIdFromClaims, emailFromClaims, isExpired } from "./tokens.js";
export { uid, num, str, bool, list } from "./api/shapes.js";
export { listTiers, sellableTiers, paymentLinkUrl, getCredits, LIVE_STATUSES } from "./api/billing.js";
export type { Tier, CreditPack, CreditBalance, Subscription } from "./api/billing.js";
export { listOrganizations, createOrganization, updateOrganization } from "./api/accounts.js";
export type { Organization } from "./api/accounts.js";
export { generateApiKey, keyEnvFor, mcpServerUrl } from "./api/apikeys.js";
export { installMcpServer, renderManualConfig, detectAgent, SERVER_NAME } from "./agents.js";
