export const resetConfirmation = "reset-godiffy-dev-data-for-clerk";

export function approvedDevReset(
  env: Record<string, string | undefined>,
): boolean {
  if (!env.GODIFFY_DEV_RESET_CONFIRMATION) return false;
  if (
    env.GODIFFY_DEV_RESET_CONFIRMATION !== resetConfirmation ||
    env.ENVIRONMENT !== "dev" ||
    env.AWS_REGION !== "eu-west-2" ||
    env.DATABASE_NAME !== "godiffy" ||
    env.DATABASE_URL ||
    !/^godiffy-dev-postgres\.[a-z0-9]+\.eu-west-2\.rds\.amazonaws\.com$/.test(
      env.DATABASE_HOST ?? "",
    ) ||
    !/^arn:aws:secretsmanager:eu-west-2:218549829565:secret:godiffy-dev-migration-[A-Za-z0-9]{6}$/.test(
      env.MIGRATION_SECRET_ARN ?? "",
    )
  )
    throw new Error("Refusing unapproved or non-Godiffy DEV reset");
  return true;
}
