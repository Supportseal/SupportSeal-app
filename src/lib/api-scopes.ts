/**
 * Workspace API scopes (docs/agent-api-plan.md, Scopes). Each scope lists the
 * scopes it implies; implication is one-directional and transitive.
 * `scopesGrant` is the single check every API route uses.
 */
export const API_SCOPES = {
  "products:read": [],
  "products:write": ["products:read"],
  "conversations:read": ["attachments:read"],
  "conversations:write": ["conversations:read"],
  "conversations:reply": ["conversations:read"],
  "conversations:assign": ["conversations:read"],
  "conversations:delete": ["conversations:read"],
  "contacts:read": [],
  "contacts:delete": ["contacts:read"],
  "saved-replies:read": [],
  "saved-replies:write": ["saved-replies:read"],
  "attachments:read": [],
  "webhooks:read": [],
  "webhooks:write": ["webhooks:read"],
  "tokens:admin": [],
  "audit:read": [],
  "workspace:read": [],
  "workspace:write": ["workspace:read"],
  "team:write": ["workspace:read"],
  "billing:write": ["workspace:read"],
} as const satisfies Record<string, readonly string[]>;

export type ApiScope = keyof typeof API_SCOPES;

export function isApiScope(value: string): value is ApiScope {
  return Object.hasOwn(API_SCOPES, value);
}

function closure(scope: ApiScope, into: Set<ApiScope>): void {
  if (into.has(scope)) return;
  into.add(scope);
  for (const implied of API_SCOPES[scope]) closure(implied, into);
}

/** True when any held scope is `needed` or implies it. Unknown stored strings grant nothing. */
export function scopesGrant(held: readonly string[], needed: ApiScope): boolean {
  const granted = new Set<ApiScope>();
  for (const scope of held) if (isApiScope(scope)) closure(scope, granted);
  return granted.has(needed);
}
