export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  severity: Severity;
  target: string;
  message: string;
}

export interface AuditableCollection {
  name: string;
  type: string;
  system?: boolean;
  fields?: { name: string; type: string; hidden?: boolean; system?: boolean }[];
  [key: string]: unknown;
}

type RuleName = "listRule" | "viewRule" | "createRule" | "updateRule" | "deleteRule" | "authRule" | "manageRule";

const WRITE_RULES: RuleName[] = ["createRule", "updateRule", "deleteRule"];
const SENSITIVE_FIELD = /(secret|token|password|passwd|api_?key|private_?key|credential)/i;

export function rulesFor(type: string): RuleName[] {
  if (type === "view") return ["listRule", "viewRule"];
  const rules: RuleName[] = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"];
  if (type === "auth") rules.push("authRule", "manageRule");
  return rules;
}

const ACTION: Record<RuleName, string> = {
  listRule: "list",
  viewRule: "view",
  createRule: "create",
  updateRule: "update",
  deleteRule: "delete",
  authRule: "authenticate against",
  manageRule: "manage (change email, password, verified status of) records of",
};

function isAnyAuthenticated(rule: string): boolean {
  return /^@request\.auth\.id\s*!=\s*(""|'')$/.test(rule.trim());
}

export function auditCollection(c: AuditableCollection): { collection: string; type: string; rules: Record<string, unknown>; findings: Finding[] } {
  const findings: Finding[] = [];
  const isAuth = c.type === "auth";
  const rules: Record<string, unknown> = {};
  const add = (severity: Severity, target: string, message: string) => findings.push({ severity, target, message });

  for (const name of rulesFor(c.type)) {
    const rule = c[name] as string | null | undefined;
    rules[name] = rule ?? null;
    const what = `${ACTION[name]} ${c.name}`;

    if (rule === null || rule === undefined) {
      add("info", name, `Locked: only superusers can ${what}.`);
      continue;
    }

    if (rule.trim() === "") {
      if (name === "authRule") {
        add("info", name, "Any user with valid credentials can authenticate (default behaviour).");
      } else if (name === "manageRule") {
        add("critical", name, `Anyone, even unauthenticated, can ${what}. This allows account takeover.`);
      } else if (name === "createRule" && isAuth) {
        add("medium", name, "Open sign-up: anyone can create an account. Fine for public apps, otherwise lock it.");
      } else if (WRITE_RULES.includes(name)) {
        add("critical", name, `Public: anyone, even unauthenticated, can ${what} any record.`);
      } else if (isAuth) {
        add("high", name, `Public: anyone, even unauthenticated, can ${what} (user records are exposed).`);
      } else {
        add("low", name, `Public: anyone, even unauthenticated, can ${what}. Make sure this data is meant to be public.`);
      }
      continue;
    }

    if (isAnyAuthenticated(rule)) {
      if (name === "updateRule" || name === "deleteRule" || name === "manageRule") {
        add("high", name, `Any authenticated user can ${what} any record, not only their own. Consider scoping to the owner (e.g. \`id = @request.auth.id\` or \`owner = @request.auth.id\`).`);
      } else if (isAuth && (name === "listRule" || name === "viewRule")) {
        add("medium", name, `Any authenticated user can ${what} all user records.`);
      } else {
        add("info", name, `Any authenticated user can ${what}.`);
      }
      continue;
    }

    if (!rule.includes("@request.auth")) {
      if (WRITE_RULES.includes(name) || name === "manageRule") {
        add("high", name, `Rule does not check @request.auth: unauthenticated requests matching \`${rule}\` can ${what}.`);
      } else if (name !== "authRule") {
        add("low", name, `Rule does not check @request.auth: unauthenticated requests matching \`${rule}\` can ${what}.`);
      }
      continue;
    }

    if (/@request\.data\b/.test(rule)) {
      add("medium", name, "Uses `@request.data`, renamed to `@request.body` in PocketBase 0.23+.");
    }
    if (name === "manageRule") {
      add("medium", name, `Users matching \`${rule}\` can change other users' email, password and verified status. Double-check it.`);
    } else {
      add("info", name, `Restricted by \`${rule}\`.`);
    }
  }

  for (const field of c.fields ?? []) {
    if (field.system || field.hidden || field.type === "password") continue;
    if (SENSITIVE_FIELD.test(field.name)) {
      add("medium", `field:${field.name}`, `Field \`${field.name}\` looks sensitive but is not hidden, so it is returned to anyone who can list or view records.`);
    }
  }

  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return { collection: c.name, type: c.type, rules, findings };
}
