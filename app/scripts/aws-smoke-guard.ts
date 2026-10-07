export function smokeInputs(env: Record<string, string | undefined>) {
  const url = new URL(env.APP_URL ?? "");
  if (
    url.protocol !== "http:" ||
    !/^godiffy-dev-[a-z0-9-]+\.eu-west-2\.elb\.amazonaws\.com$/.test(
      url.hostname,
    ) ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    env.AWS_REGION !== "eu-west-2" ||
    env.IMAGE_BUCKET !== "godiffy-dev-images-218549829565-eu-west-2" ||
    !/^arn:aws:secretsmanager:eu-west-2:218549829565:secret:godiffy-dev-smoke-fixtures(?:-[A-Za-z0-9]{6})?$/.test(
      env.SMOKE_SECRET_ARN ?? "",
    ) ||
    env.IMAGE_BUCKET!.split("-")[3] !== env.SMOKE_SECRET_ARN!.split(":")[4]
  )
    throw new Error("unsafe smoke configuration");
  return {
    origin: url.origin,
    bucket: env.IMAGE_BUCKET!,
    region: env.AWS_REGION!,
    fixtureArn: env.SMOKE_SECRET_ARN!,
  };
}

export function s3Url(value: string, bucket: string, region: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== `${bucket}.s3.${region}.amazonaws.com` ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("unsafe S3 URL");
  return url;
}
