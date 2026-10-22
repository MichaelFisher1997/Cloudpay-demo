import { createHash } from "node:crypto";

export interface ResourceIdentity {
  address: string;
  id: string;
  arn: string | null;
}

interface State {
  resources?: Array<{
    mode: string;
    module?: string;
    type: string;
    name: string;
    instances?: Array<{
      index_key?: string | number;
      attributes?: { id?: unknown; arn?: unknown };
    }>;
  }>;
}

export interface Plan {
  resource_changes?: Array<{
    address: string;
    mode: string;
    change: {
      actions: string[];
      before?: { id?: unknown; arn?: unknown } | null;
    };
  }>;
}

export function identities(state: State): ResourceIdentity[] {
  return (state.resources ?? [])
    .filter((resource) => resource.mode === "managed")
    .flatMap((resource) =>
      (resource.instances ?? []).map((instance) => {
        const attributes = instance.attributes ?? {};
        if (typeof attributes.id !== "string") {
          throw new Error("Managed state resource has no string identifier");
        }
        const suffix = instance.index_key === undefined ? "" : `[${JSON.stringify(instance.index_key)}]`;
        return {
          address: `${resource.module ? `${resource.module}.` : ""}${resource.type}.${resource.name}${suffix}`,
          id: attributes.id,
          arn: typeof attributes.arn === "string" ? attributes.arn : null,
        };
      }),
    )
    .sort((left, right) => (left.address < right.address ? -1 : left.address > right.address ? 1 : 0));
}

export function fingerprint(resources: ResourceIdentity[]): string {
  const sorted = resources.map(({ address, id, arn }) => ({ address, id, arn }))
    .sort((left, right) => (left.address < right.address ? -1 : left.address > right.address ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export function assertFingerprint(resources: ResourceIdentity[], approved: string): void {
  if (fingerprint(resources) !== approved) {
    throw new Error("Live state resource identifiers differ from the approved inventory; stop and re-inventory");
  }
}

export function assertDestroyPlan(plan: Plan, approved: ResourceIdentity[]): string[] {
  const expected = new Map(approved.map((resource) => [resource.address, resource]));
  const deletions: string[] = [];
  for (const resource of plan.resource_changes ?? []) {
    if (resource.mode === "data") continue;
    if (resource.change.actions.length === 1 && resource.change.actions[0] === "no-op") continue;
    if (resource.change.actions.length !== 1 || resource.change.actions[0] !== "delete") {
      throw new Error(`Retirement plan contains a non-delete action: ${resource.address}`);
    }
    const original = expected.get(resource.address);
    const before = resource.change.before;
    if (!original || before?.id !== original.id || (before?.arn ?? null) !== original.arn) {
      throw new Error(`Retirement plan includes an unapproved resource identity: ${resource.address}`);
    }
    deletions.push(resource.address);
  }
  return deletions;
}

export function assertExecutionContext(
  environment: Record<string, string | undefined>,
  mode: string,
): void {
  if (mode !== "plan" && mode !== "destroy") throw new Error("Unknown retirement operation");
  if (environment.GITHUB_REPOSITORY !== "MichaelFisher1997/Cloudpay-demo" || environment.GITHUB_REF !== "refs/heads/dev") {
    throw new Error("Retirement may run only in the approved repository on dev");
  }
  if (!/^[0-9a-f]{40}$/.test(environment.GITHUB_SHA ?? "") || environment.REVIEWED_REVISION !== environment.GITHUB_SHA) {
    throw new Error("The reviewed revision does not match the workflow revision");
  }
  if (mode === "destroy" && environment.RETIREMENT_CONFIRMATION !== "DELETE GODIFFY 218549829565") {
    throw new Error("The explicit destructive confirmation is missing");
  }
}
