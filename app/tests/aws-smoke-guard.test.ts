import { expect, test } from "bun:test";
import { smokeInputs, s3Url } from "../scripts/aws-smoke-guard";

const valid = {
  APP_URL: "http://godiffy-dev-123.eu-west-2.elb.amazonaws.com",
  IMAGE_BUCKET: "godiffy-dev-images-218549829565-eu-west-2",
  AWS_REGION: "eu-west-2",
  SMOKE_SECRET_ARN:
    "arn:aws:secretsmanager:eu-west-2:218549829565:secret:godiffy-dev-smoke-fixtures-ABC123",
};
test("smoke rejects non-dev targets before AWS access", () => {
  expect(smokeInputs(valid).origin).toBe(valid.APP_URL);
  for (const [key, value] of [
    ["APP_URL", "https://godiffy-dev-123.eu-west-2.elb.amazonaws.com"],
    ["APP_URL", "http://godiffy-prod-123.eu-west-2.elb.amazonaws.com"],
    ["APP_URL", "http://custom.example"],
    ["APP_URL", "http://godiffy-dev-123.eu-west-2.elb.amazonaws.com/path"],
    ["AWS_REGION", "us-east-1"],
    ["IMAGE_BUCKET", "godiffy-prod-images"],
    ["IMAGE_BUCKET", "godiffy-dev-images-123456789012-eu-west-2"],
    [
      "SMOKE_SECRET_ARN",
      "arn:aws:secretsmanager:eu-west-2:218549829565:secret:godiffy-dev-master-ABC123",
    ],
  ])
    expect(() => smokeInputs({ ...valid, [key]: value })).toThrow();
});
test("only the exact regional HTTPS bucket endpoint is accepted", () => {
  expect(
    s3Url(
      "https://godiffy-dev-images-218549829565-eu-west-2.s3.eu-west-2.amazonaws.com/key",
      valid.IMAGE_BUCKET,
      valid.AWS_REGION,
    ).pathname,
  ).toBe("/key");
  for (const url of [
    "http://godiffy-dev-images-218549829565-eu-west-2.s3.eu-west-2.amazonaws.com/key",
    "https://example.com/key",
    "https://godiffy-dev-images-218549829565-eu-west-2.s3.us-east-1.amazonaws.com/key",
  ])
    expect(() => s3Url(url, valid.IMAGE_BUCKET, valid.AWS_REGION)).toThrow();
});
