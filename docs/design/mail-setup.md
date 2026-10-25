# Mail setup (custom inbound mail domain) — V1 default

Status: working defaults, the maintainer can override. Builds on FR-EMAIL-01,
[onboarding.md](onboarding.md) ("everything else is a checklist item, not a
gate") and [open-questions.md](../open-questions.md) D13.

- **Optional, recommended.** A Mail step sits between Domain and Install; the
  wizard offers **Skip for now** until the domain is verified. The generated
  `product_xxx@…` address keeps working without any setup.
- **Records.** MX on the customer's (sub)domain → the instance mail host
  (`INBOUND_MX_HOSTS`, else live MX of `INBOUND_EMAIL_DOMAIN`; hosted: the
  `supportseal.app` apex), plus TXT `_inbound-verify.<domain>` =
  `inbound-verify=<token>` proving zone control. The MX check requires every
  MX on the domain to be an instance host (a foreign MX would split mail).
- **No SPF/DKIM here.** They authorise *sending*; replies leave from the
  managed sender, so inbound needs neither. Verified custom sending domains
  stay V2 ([sender-domains.md](sender-domains.md)).
- **Verification = real DNS** from the app server (`node:dns`), no third-party
  service, same hosted and self-hosted. Verified only when MX and TXT both
  pass; a definitive miss (NXDOMAIN, wrong value) revokes an earlier
  verification, a timeout/SERVFAIL changes nothing.
- **Routing.** Verified domain = catch-all for its one Product (after the
  exact-address and reply-token lookups). Unverified domains route nothing.
  The instance's own inbound domain (and subdomains) cannot be claimed.
- **D13.** The generated address is stamped `inboundEmailVerified` at
  allocation and only a verified `inboundEmail` routes (issue #169); domain
  status lives in `ProductMailDomain`. One domain per Product; Admin only;
  Workspace-scoped.
- **Not automated:** registering the hostname with the hosted inbound provider
  (SendGrid Inbound Parse); DNS proof only covers the customer's side.
