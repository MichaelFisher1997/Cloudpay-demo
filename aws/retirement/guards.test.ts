import { describe, expect, test } from "bun:test";
import { assertDestroyPlan, assertExecutionContext, assertFingerprint, fingerprint, identities, type Plan } from "./guards";

const resource = { address: "module.godiffy.aws_vpc.this", id: "vpc-approved", arn: "arn:aws:ec2:eu-west-2:218549829565:vpc/vpc-approved" };
const context = {
  GITHUB_REPOSITORY: "MichaelFisher1997/Cloudpay-demo",
  GITHUB_REF: "refs/heads/dev",
  GITHUB_SHA: "a".repeat(40),
  REVIEWED_REVISION: "a".repeat(40),
  RETIREMENT_CONFIRMATION: "DELETE GODIFFY 218549829565",
};
const plan = (id = resource.id, arn: string | null = resource.arn, actions = ["delete"], address = resource.address): Plan => ({ resource_changes: [{ address, mode: "managed", change: { actions, before: { id, arn } } }] });

describe("retirement plan guard", () => {
  test("accepts an exact deletion and an empty already-retired slice", () => {
    expect(assertDestroyPlan(plan(), [resource])).toEqual([resource.address]);
    expect(assertDestroyPlan({}, [resource])).toEqual([]);
  });
  test("rejects a changed ID, ARN, account or address", () => {
    expect(() => assertDestroyPlan(plan("vpc-unrelated"), [resource])).toThrow();
    expect(() => assertDestroyPlan(plan(resource.id, null), [resource])).toThrow();
    expect(() => assertDestroyPlan(plan(resource.id, resource.arn.replace("218549829565", "999999999999")), [resource])).toThrow();
    expect(() => assertDestroyPlan(plan(resource.id, resource.arn, ["delete"], "module.portyard.aws_vpc.this"), [resource])).toThrow();
  });
  test.each([{ actions: ["create"] }, { actions: ["update"] }, { actions: ["delete", "create"] }, { actions: ["create", "delete"] }])("rejects non-delete actions $actions", ({ actions }) => {
    expect(() => assertDestroyPlan(plan(resource.id, resource.arn, [...actions]), [resource])).toThrow();
  });
  test("ignores data sources and no-op changes", () => {
    const value = plan();
    value.resource_changes!.push({ address: "data.aws_ecr_image.release", mode: "data", change: { actions: ["delete"] } });
    value.resource_changes!.push({ address: "unchanged", mode: "managed", change: { actions: ["no-op"] } });
    expect(assertDestroyPlan(value, [resource])).toEqual([resource.address]);
  });
});

describe("state inventory fingerprint", () => {
  test("normalizes resource ordering without losing IDs or ARNs", () => {
    const second = { ...resource, address: "module.godiffy.aws_vpc.second" };
    expect(fingerprint([resource, second])).toBe(fingerprint([second, resource]));
    expect(() => assertFingerprint([resource], fingerprint([{ ...resource, id: "changed" }]))).toThrow();
    expect(() => assertFingerprint([], fingerprint([resource]))).toThrow();
  });
  test("includes indexed addresses and skips data resources", () => {
    expect(identities({ resources: [
      { mode: "managed", module: "module.godiffy", type: "aws_subnet", name: "public", instances: [{ index_key: "eu-west-2a", attributes: { id: "subnet-approved" } }] },
      { mode: "data", type: "aws_ecr_image", name: "image", instances: [{ attributes: { id: "ignored" } }] },
    ] })).toEqual([{ address: 'module.godiffy.aws_subnet.public["eu-west-2a"]', id: "subnet-approved", arn: null }]);
  });
  test("fails closed on a missing managed resource ID", () => {
    expect(() => identities({ resources: [{ mode: "managed", type: "aws_vpc", name: "this", instances: [{}] }] })).toThrow();
  });
});

describe("execution context", () => {
  test("accepts approved plan and destroy contexts", () => {
    expect(() => assertExecutionContext(context, "plan")).not.toThrow();
    expect(() => assertExecutionContext(context, "destroy")).not.toThrow();
  });
  test.each(["GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_SHA", "REVIEWED_REVISION", "RETIREMENT_CONFIRMATION"])('rejects a mismatched %s', (key) => {
    expect(() => assertExecutionContext({ ...context, [key]: "wrong" }, "destroy")).toThrow();
  });
  test("never runs locally or with an unknown mode", () => {
    expect(() => assertExecutionContext({}, "destroy")).toThrow();
    expect(() => assertExecutionContext(context, "apply")).toThrow();
  });
});
