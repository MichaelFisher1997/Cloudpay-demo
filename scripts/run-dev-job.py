"""Run only a reviewed private Godiffy DEV Fargate job; report checked exit status."""
import argparse
import json
import subprocess
from pathlib import Path


def aws(*args):
    result = subprocess.run(["aws", "--region", "eu-west-2", "--no-cli-pager", *args, "--output", "json"], check=True, capture_output=True, text=True)
    return json.loads(result.stdout) if result.stdout.strip() else {}


def validate_target(data, identity):
    if data["account_id"] != "218549829565" or data["region"] != "eu-west-2" or data["environment"] != "dev" or data["cluster_name"] != "godiffy-dev-cluster":
        raise RuntimeError("Unexpected target")
    if identity["Account"] != "218549829565" or ":assumed-role/cloudpay-demo-github-actions/" not in identity["Arn"]:
        raise RuntimeError("Private jobs must use the DEV GitHub Actions identity")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", choices=["bootstrap", "migrate", "verify"])
    parser.add_argument("--outputs", type=Path, default=Path("terraform/environments/dev/deployment.json"))
    args = parser.parse_args()
    data = json.loads(args.outputs.read_text())["deployment"]["value"]
    identity = aws("sts", "get-caller-identity")
    validate_target(data, identity)
    definition = data["job_task_definitions"][args.job]
    if not definition.startswith(f"arn:aws:ecs:eu-west-2:218549829565:task-definition/godiffy-dev-{args.job}:"):
        raise RuntimeError("Unexpected task definition")
    network = {"awsvpcConfiguration": {"subnets": data["task_subnet_ids"], "securityGroups": [data["task_security_group"]], "assignPublicIp": "DISABLED"}}
    run = aws("ecs", "run-task", "--cluster", data["cluster_name"], "--task-definition", definition, "--launch-type", "FARGATE", "--platform-version", "1.4.0", "--network-configuration", json.dumps(network), "--tags", "key=Project,value=godiffy", "key=Environment,value=dev", "key=ManagedBy,value=terraform", "key=Purpose,value=cloudpay-technical-assessment")
    if run.get("failures") or len(run.get("tasks", [])) != 1:
        raise RuntimeError("Private task failed to launch")
    arn = run["tasks"][0]["taskArn"]
    aws("ecs", "wait", "tasks-stopped", "--cluster", data["cluster_name"], "--tasks", arn)
    task = aws("ecs", "describe-tasks", "--cluster", data["cluster_name"], "--tasks", arn)["tasks"][0]
    containers = task["containers"]
    summary = {"job": args.job, "task": arn, "status": task["lastStatus"], "exit_codes": [container.get("exitCode") for container in containers]}
    print(json.dumps(summary))
    if task["lastStatus"] != "STOPPED" or any(container.get("exitCode") != 0 for container in containers):
        # Job log content is deliberately not dumped; operators inspect exact streams.
        raise RuntimeError("Private job failed; inspect dedicated CloudWatch stream")
