/**
 * Accounts API: organizations, and the account behind them.
 *
 * @remarks
 * Two request shapes are easy to get wrong: `account_id` is sent as an id object
 * (`{ value }`), and the `PATCH` body repeats the resource name alongside the payload.
 */

import type { Config } from "../config.js";
import { request } from "../http.js";
import { list, num, str, uid, type Uid } from "./shapes.js";

/** An organization, normalized from the API's response. */
export interface Organization {
  id: string;
  name: string | null;
  website: string | null;
  industry: string | null;
  onboarded: boolean;
  tier: string | null;
}

/** An organization as the API returns it. */
interface RawOrganization {
  _id?: Uid;
  name?: unknown;
  website?: unknown;
  industry?: unknown;
  onboarded?: unknown;
  tier?: { tier?: unknown; name?: unknown };
}

/**
 * Normalizes an organization.
 *
 * @remarks
 * An absent `onboarded` means onboarding was never finished, which is the common case for a
 * placeholder organization.
 *
 * @returns The organization, or null when it carries no id.
 */
function toOrganization(raw: RawOrganization): Organization | null {
  const id = uid(raw._id);
  if (!id) return null;
  return {
    id,
    name: str(raw.name),
    website: str(raw.website),
    industry: str(raw.industry),
    onboarded: raw.onboarded === true || (typeof raw.onboarded === "object" && (raw.onboarded as { value?: boolean })?.value === true),
    tier: raw.tier ? (str(raw.tier.name) ?? (typeof raw.tier.tier === "string" ? raw.tier.tier : null)) : null,
  };
}

/** Lists the organizations the account belongs to. */
export async function listOrganizations(
  config: Config,
  token: string,
  accountId: string,
): Promise<Organization[]> {
  const payload = await request<unknown>(
    `${config.endpoints.accounts}/v1alpha/accounts/${encodeURIComponent(accountId)}/organizations`,
    { token, allow404: true },
  );
  return list<RawOrganization>(payload, "organizations")
    .map(toOrganization)
    .filter((o): o is Organization => o !== null);
}

/**
 * Create an organization.
 *
 * `onboarded: true` tells the web app the organization is already named, so it skips the
 * create/rename form it otherwise shows when the user returns from Stripe. The accounts service
 * rejects it without an explicit name — an unnamed org gets a generated name, and that's
 * exactly when the form should still appear.
 */
export async function createOrganization(
  config: Config,
  token: string,
  accountId: string,
  fields: { name?: string; website?: string; industry?: string; onboarded?: boolean } = {},
): Promise<Organization> {
  const body: Record<string, unknown> = { account_id: { value: accountId } };
  const organization: Record<string, unknown> = {};
  if (fields.name) organization["name"] = fields.name;
  if (fields.website) organization["website"] = fields.website;
  if (fields.industry) organization["industry"] = fields.industry;
  if (fields.onboarded && fields.name) organization["onboarded"] = true;
  if (Object.keys(organization).length > 0) body["organization"] = organization;

  const raw = await request<RawOrganization>(`${config.endpoints.accounts}/v1alpha/organizations`, {
    method: "POST",
    token,
    body,
  });
  const org = raw ? toOrganization(raw) : null;
  if (!org) throw new Error("The accounts service created an organization but returned no id.");
  return org;
}

/**
 * Update the organization. The accounts service sets `onboarded = true` on every update, so a
 * rename is also what finishes a stub the web app created.
 */
export async function updateOrganization(
  config: Config,
  token: string,
  orgId: string,
  fields: { name?: string; website?: string; industry?: string; onboarded?: boolean },
): Promise<Organization> {
  const organization: Record<string, unknown> = {};
  if (fields.name !== undefined) organization["name"] = fields.name;
  if (fields.website !== undefined) organization["website"] = fields.website;
  if (fields.industry !== undefined) organization["industry"] = fields.industry;
  if (fields.onboarded !== undefined) organization["onboarded"] = fields.onboarded;

  const raw = await request<RawOrganization>(
    `${config.endpoints.accounts}/v1alpha/organizations/${encodeURIComponent(orgId)}`,
    {
      method: "PATCH",
      token,
      body: { organization, name: `organizations/${orgId}` },
    },
  );
  const org = raw ? toOrganization(raw) : null;
  if (!org) throw new Error("The accounts service updated the organization but returned no id.");
  return org;
}

/** The display fields of an account. */
export interface AccountProfile {
  id: string;
  email: string | null;
  fullName: string | null;
}

/** Fetches an account's profile, or null when it does not exist. */
export async function getAccount(
  config: Config,
  token: string,
  accountId: string,
): Promise<AccountProfile | null> {
  const raw = await request<{ _id?: Uid; profile?: Record<string, unknown> }>(
    `${config.endpoints.accounts}/v1alpha/accounts/${encodeURIComponent(accountId)}`,
    { token, allow404: true },
  );
  if (!raw) return null;
  const id = uid(raw._id) ?? accountId;
  return {
    id,
    email: str(raw.profile?.["email"]),
    fullName: str(raw.profile?.["fullName"]),
  };
}

export { num };
