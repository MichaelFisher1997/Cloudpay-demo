"""Human SSO bootstrap of exact DEV CI policies; never deploys application resources."""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ACCOUNT = "218549829565"
ROLE = "cloudpay-demo-github-actions"
TAGS = {"Project": "godiffy", "Environment": "dev", "ManagedBy": "terraform", "Purpose": "cloudpay-technical-assessment"}


def aws(*args, allow_missing=False):
    command = ["aws", "--profile", "portyard", "--region", "eu-west-2", "--no-cli-pager", "--cli-connect-timeout", "10", "--cli-read-timeout", "60", *args, "--output", "json"]
    for attempt in range(3):
        result = subprocess.run(command, capture_output=True, text=True, timeout=180)
        if result.returncode == 0 or result.returncode == 254:
            break
        # Retry reads and the idempotent exact policy attachment only. A create
        # with a lost response is checked on the next bootstrap run.
        if (args[1].startswith(("get-", "list-")) or args[1] == "attach-role-policy") and attempt < 2:
            continue
        break
    if result.returncode:
        if allow_missing and "NoSuchEntity" in result.stderr:
            return None
        code = re.search(r"\(([A-Za-z0-9]+)\) when calling", result.stderr)
        network = re.search(r"(Read timeout|Connect timeout|Could not connect|SSL validation failed|Failed to connect to proxy)", result.stderr)
        reason = code.group(1) if code else network.group(1) if network else f"CLI failure {result.returncode}"
        if not code and not network:
            diagnostic = Path("/tmp/opencode/godiffy-ci-bootstrap-error.log")
            diagnostic.write_text(result.stderr)
            diagnostic.chmod(0o600)
        raise RuntimeError(f"AWS operation failed: {' '.join(args[:2])}: {reason}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


if __name__ == "__main__":
    identity = aws("sts", "get-caller-identity")
    if identity["Account"] != ACCOUNT or ":assumed-role/AWSReservedSSO_PortyardAdministrator_" not in identity["Arn"]:
        raise RuntimeError("Expected the existing human SSO account/role")
    role = aws("iam", "get-role", "--role-name", ROLE)["Role"]
    expected = json.loads((ROOT / "aws/github-actions-trust-policy.json").read_text())
    if role["AssumeRolePolicyDocument"] != expected:
        raise RuntimeError("Unexpected existing GitHub trust; refusing to change it")
    attached = {policy["PolicyArn"] for policy in aws("iam", "list-attached-role-policies", "--role-name", ROLE)["AttachedPolicies"]}
    policies = sorted((ROOT / "aws/ci/policies").glob("*.json"))
    if len(policies) != 9:
        raise RuntimeError("Expected nine reviewable DEV policies")
    for file in policies:
        name = f"godiffy-dev-{file.stem}"
        arn = f"arn:aws:iam::{ACCOUNT}:policy/{name}"
        policy = json.loads(file.read_text())
        current = aws("iam", "get-policy", "--policy-arn", arn, allow_missing=True)
        if current:
            tags = aws("iam", "list-policy-tags", "--policy-arn", arn)
            if {tag["Key"]: tag["Value"] for tag in tags["Tags"]} != TAGS:
                raise RuntimeError("Refusing to reuse an unowned policy")
            version = current["Policy"]["DefaultVersionId"]
            existing = aws("iam", "get-policy-version", "--policy-arn", arn, "--version-id", version)["PolicyVersion"]["Document"]
            if existing != policy:
                versions = aws("iam", "list-policy-versions", "--policy-arn", arn)["Versions"]
                if len(versions) >= 5:
                    raise RuntimeError("Policy version limit: do not delete versions autonomously")
                aws("iam", "create-policy-version", "--policy-arn", arn, "--policy-document", f"file://{file}", "--set-as-default")
                print(f"Updated exact DEV policy: {name}")
        else:
            aws("iam", "create-policy", "--policy-name", name, "--policy-document", f"file://{file}", "--tags", *[f"Key={key},Value={value}" for key, value in TAGS.items()])
            print(f"Created exact DEV policy: {name}")
        if file.stem.startswith("ci-") and arn not in attached:
            aws("iam", "attach-role-policy", "--role-name", ROLE, "--policy-arn", arn)
    print("DEV CI bootstrap complete. OIDC trust/profile/backend/application resources unchanged.")
