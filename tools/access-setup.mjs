/* ============================================================================
   ESMERINGHOY — PUT CLOUDFLARE ACCESS IN FRONT OF THE ADMIN PANEL
   ----------------------------------------------------------------------------
   The admin page and the statistics API are not part of the public site: they
   are the two paths that should require a real identity, not just a password.
   This script configures that with Cloudflare Access (Zero Trust), which lives
   in front of the Worker, so an unauthenticated request never reaches the code.

   Covered, on both the apex and www:

     /admin.html   the panel itself (direct filename)
     /admin        the same page through the Worker's extensionless fallback —
                   easy to forget, and it would leave the panel reachable
     /stats        the statistics API the panel calls

   Deliberately NOT covered: /, /player.html, /catalog.js, /token, /track and
   signed media URLs. Note that Access path rules ignore query strings, so a
   signed media URL on another path is unaffected by these rules.

   Usage:
     node tools/access-setup.mjs                 read-only: print what exists
     node tools/access-setup.mjs --apply         create the missing pieces
     node tools/access-setup.mjs --apply --verify  ...then prove it with a
                                                 temporary service token, which
                                                 is deleted again at the end

   Credentials, in order of preference:
     .secrets/cf-api-token        a purpose-made API token (recommended)
     CLOUDFLARE_API_TOKEN         same value via the environment

   The token needs, for the account that owns the zone:
     Access: Apps and Policies            Edit
     Access: Organizations, Identity Providers, and Groups  Edit
     Access: Service Tokens               Edit   (only for --verify)

   This script is idempotent: every step reads first and creates only what is
   missing, so running it twice changes nothing.
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "0b94f2b10f74c5f22f84e0b032059fe8";
const ZONE_HOSTS = ["esmeringhoy.eu.cc", "www.esmeringhoy.eu.cc"];
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "demshots015@gmail.com").split(",").map((e) => e.trim()).filter(Boolean);
const TEAM_DOMAIN = process.env.ACCESS_TEAM_DOMAIN || "esmeringhoy";

/* Paths, grouped into the applications the dashboard will show. */
const APPLICATIONS = [
  { name: "Esmeringhoy admin panel", paths: ["/admin.html", "/admin"] },
  { name: "Esmeringhoy statistics API", paths: ["/stats"] }
];

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");

function token() {
  const file = path.join(process.cwd(), ".secrets/cf-api-token");
  if (fs.existsSync(file)) {
    const value = fs.readFileSync(file, "utf8").trim();
    if (value) return value;
  }
  const env = process.env.CLOUDFLARE_API_TOKEN;
  if (env) return env;
  console.error("No token. Put an Access-scoped API token in .secrets/cf-api-token, or set CLOUDFLARE_API_TOKEN.");
  process.exit(2);
}

const AUTH = { Authorization: "Bearer " + token(), "Content-Type": "application/json" };
const API = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT;

async function api(method, url, body) {
  const response = await fetch(url, { method, headers: AUTH, body: body ? JSON.stringify(body) : undefined });
  let json = {};
  try {
    json = await response.json();
  } catch {
    /* a non-JSON body means something upstream, the status is still useful */
  }
  return { status: response.status, ok: Boolean(json.success), result: json.result, errors: json.errors || [] };
}

function describe(errors) {
  return errors.map((e) => e.code + ": " + e.message).join(" | ") || "(no error detail)";
}

function step(label) {
  console.log("\n== " + label);
}

/* ------------------------------------------------------------------- zone -- */

step("account and zone");
const zones = await api("GET", "https://api.cloudflare.com/client/v4/zones?account.id=" + ACCOUNT);
if (!zones.ok) {
  console.log("  cannot list zones: " + describe(zones.errors));
} else {
  console.log("  zones in this account: " + (zones.result.length ? zones.result.map((z) => z.name + " (" + z.status + ")").join(", ") : "none"));
}

/* ------------------------------------------------------- zero trust org --- */

step("zero trust organisation (the team domain users log in through)");
let org = await api("GET", API + "/access/organizations");
if (org.ok && org.result) {
  console.log("  exists: " + org.result.auth_domain + ".cloudflareaccess.com  (session " + org.result.session_duration + ")");
} else if (!APPLY) {
  console.log("  missing — would create team domain " + TEAM_DOMAIN + ".cloudflareaccess.com");
} else {
  const created = await api("POST", API + "/access/organizations", {
    name: "Esmeringhoy",
    auth_domain: TEAM_DOMAIN,
    session_duration: "24h"
  });
  if (created.ok) {
    org = created;
    console.log("  created: " + created.result.auth_domain + ".cloudflareaccess.com");
  } else {
    console.log("  could not create: " + describe(created.errors));
    console.log("  If this is a permissions error, visit dash.cloudflare.com -> Zero Trust once and pick a team name,");
    console.log("  then re-run this script to finish the applications and policies.");
  }
}

/* ------------------------------------------------------ one-time PIN idp -- */

step("identity providers");
const idps = await api("GET", API + "/access/identity_providers");
if (!idps.ok) {
  console.log("  cannot list: " + describe(idps.errors));
} else {
  const types = idps.result.map((p) => p.type);
  console.log("  configured: " + (types.length ? types.join(", ") : "(none — new organisations point at the Cloudflare provider)"));
  if (!types.includes("onetimepin")) {
    if (!APPLY) {
      console.log("  would add: onetimepin (login by emailed code, no other account needed)");
    } else {
      const otp = await api("POST", API + "/access/identity_providers", { name: "One-time PIN", type: "onetimepin", config: {} });
      console.log(otp.ok ? "  added: onetimepin" : "  could not add onetimepin: " + describe(otp.errors));
    }
  }
}

/* ----------------------------------------------------------- applications -- */

step("access applications");
const apps = await api("GET", API + "/access/apps");
if (!apps.ok) {
  console.log("  cannot list: " + describe(apps.errors));
  process.exit(1);
}
const existing = apps.result.map((a) => ({ name: a.name, domains: [a.domain, ...(a.self_hosted_domains || [])].filter(Boolean), id: a.id, policies: a.policies || [] }));
console.log("  existing: " + (existing.length ? existing.map((a) => a.name).join(", ") : "(none)"));

const wanted = [];
for (const app of APPLICATIONS) {
  for (const host of ZONE_HOSTS) {
    for (const p of app.paths) wanted.push({ app: app.name, url: host + p });
  }
}

const missing = wanted.filter((w) => !existing.some((a) => a.domains.includes(w.url)));
console.log("  " + wanted.length + " URLs to cover, " + (wanted.length - missing.length) + " already covered");
for (const m of missing) console.log("    would cover: " + m.url);

if (APPLY && missing.length) {
  for (const app of APPLICATIONS) {
    const urls = wanted.filter((w) => w.app === app.name).map((w) => w.url);
    if (!urls.some((u) => missing.some((m) => m.url === u))) continue;

    const created = await api("POST", API + "/access/apps", {
      name: app.name,
      type: "self_hosted",
      domain: urls[0],
      self_hosted_domains: urls,
      session_duration: "24h",
      allowed_idps: [],
      auto_redirect_to_identity: false,
      http_only_cookie_attribute: true,
      same_site_cookie_attribute: "lax"
    });
    if (!created.ok) {
      console.log("  could not create " + app.name + ": " + describe(created.errors));
      continue;
    }
    console.log("  created " + app.name + " covering " + urls.length + " URLs");

    const policy = await api("POST", API + "/access/apps/" + created.result.id + "/policies", {
      name: "Admins",
      decision: "allow",
      include: ADMIN_EMAILS.map((email) => ({ email: { email } }))
    });
    console.log(policy.ok
      ? "    allow policy for: " + ADMIN_EMAILS.join(", ")
      : "    policy failed: " + describe(policy.errors));
  }
}

/* -------------------------------------------------------------- verify ----- */

if (VERIFY) {
  step("proving it (temporary service token, removed afterwards)");
  if (!APPLY) {
    console.log("  --verify needs --apply, so the policy exists first");
  } else {
    const service = await api("POST", API + "/access/service_tokens", { name: "verify-" + Date.now(), duration: "1h" });
    if (!service.ok) {
      console.log("  could not create a service token: " + describe(service.errors));
    } else {
      const { client_id: clientId, client_secret: clientSecret, id } = service.result;
      const headers = { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret };

      /* The service token alone is not enough: the application also needs a
         Service Auth policy that names it, otherwise Access still refuses. */
      const policyIds = [];
      for (const app of (await api("GET", API + "/access/apps")).result || []) {
        const policy = await api("POST", API + "/access/apps/" + app.id + "/policies", {
          name: "verify service token",
          decision: "non_identity",
          include: [{ service_token: { token_id: id } }]
        });
        if (policy.ok) policyIds.push({ app: app.id, policy: policy.result.id });
      }

      const probes = [
        ["https://esmeringhoy.eu.cc/admin.html", "admin page (signed)"],
        ["https://esmeringhoy.eu.cc/admin", "admin page via the short path"],
        ["https://esmeringhoy.eu.cc/stats", "statistics API"],
        ["https://esmeringhoy.eu.cc/player.html", "public page, must stay open"]
      ];
      for (const [url, label] of probes) {
        const withToken = await fetch(url, { headers, redirect: "manual" });
        const without = await fetch(url, { redirect: "manual" });
        console.log("  " + label.padEnd(30) + " token " + withToken.status + "  |  anonymous " + without.status + (without.headers.get("location") ? " -> " + new URL(without.headers.get("location")).host : ""));
      }

      for (const { app, policy } of policyIds) {
        await api("DELETE", API + "/access/apps/" + app + "/policies/" + policy);
      }
      const removed = await api("DELETE", API + "/access/service_tokens/" + id);
      console.log(removed.ok ? "  temporary service token and its policies removed" : "  remove the service token manually: " + describe(removed.errors));
    }
  }
}

console.log("\nDone" + (APPLY ? "" : " (read-only run — add --apply to create)") + ".");
