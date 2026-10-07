"""Explicitly approved retention of the healthy DEV service after a failed status read.

Verifies the original service creation, immutable image, private network and ALB health.
Changes only Terraform's failed-read taint, never AWS resources or application data.
"""
import argparse
from datetime import datetime
import json
import re
import subprocess

ACCOUNT = "218549829565"
REGION = "eu-west-2"
CLUSTER = "godiffy-dev-cluster"
SERVICE = "godiffy-dev-web"
CLUSTER_ARN = f"arn:aws:ecs:{REGION}:{ACCOUNT}:cluster/{CLUSTER}"
SERVICE_ARN = f"arn:aws:ecs:{REGION}:{ACCOUNT}:service/{CLUSTER}/{SERVICE}"
# Explicitly approved after the relative six-hour guard expired during the pause.
# Exact creation pins this one failed attempt; no broader age window is accepted.
APPROVED_CREATION = datetime.fromisoformat("2026-10-07T14:27:37.018000+00:00")
ADDRESS = "module.godiffy.module.application.aws_ecs_service.this[0]"
TAGS = {"Project": "godiffy", "Environment": "dev", "ManagedBy": "terraform", "Purpose": "cloudpay-technical-assessment"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def read(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    require(result.returncode == 0, "Read-only service repair verification failed")
    return json.loads(result.stdout)


def aws(*args):
    return read(["aws", "--region", REGION, "--no-cli-pager", *args, "--output", "json"])


def main(digest):
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", digest), "Expected reviewed immutable image digest")
    identity = aws("sts", "get-caller-identity")
    require(identity["Account"] == ACCOUNT and ":assumed-role/cloudpay-demo-github-actions/" in identity["Arn"], "Repair must use the exact DEV Actions identity")
    state = read(["terraform", "-chdir=terraform/environments/dev", "state", "pull"])
    resources = state.get("resources", [])
    matches = [resource for resource in resources if resource.get("module") == "module.godiffy.module.application" and resource["type"] == "aws_ecs_service" and resource["name"] == "this"]
    require(len(matches) == 1 and len(matches[0]["instances"]) == 1, "Expected exact failed-new DEV service state record")
    instance = matches[0]["instances"][0]
    require(instance.get("status") == "tainted" and instance.get("index_key") == 0 and instance["attributes"]["id"] == SERVICE_ARN, "Expected exact failed status-read taint")
    d = state["outputs"]["deployment"]["value"]
    require(d["account_id"] == ACCOUNT and d["region"] == REGION and d["environment"] == "dev" and d["image_digest"] == digest, "Unexpected deployment identity/image")
    definitions = [item for resource in resources if resource.get("module") == "module.godiffy.module.application" and resource["type"] == "aws_ecs_task_definition" and resource["name"] == "web" for item in resource["instances"] if item.get("index_key") == digest]
    require(len(definitions) == 1, "Expected reviewed web definition in state")
    definition = definitions[0]["attributes"]["arn"]
    require(definition.startswith(f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/{SERVICE}:"), "Wrong web definition family")

    response = aws("ecs", "describe-services", "--cluster", CLUSTER, "--services", SERVICE, "--include", "TAGS")
    require(not response.get("failures") and len(response["services"]) == 1, "Expected exact existing service")
    service = response["services"][0]
    require(datetime.fromisoformat(service["createdAt"]) == APPROVED_CREATION, "Only the exact approved original service creation is repairable")
    require(service["serviceArn"] == SERVICE_ARN and service["clusterArn"] == CLUSTER_ARN and service["status"] == "ACTIVE", "Wrong service identity/status")
    require({tag["key"]: tag["value"] for tag in service["tags"]} == TAGS, "Wrong service ownership")
    require(service["desiredCount"] == 1 and service["runningCount"] == 1 and service["pendingCount"] == 0 and service["taskDefinition"] == definition, "Wrong replica count or definition")
    require(service["launchType"] == "FARGATE" and not service["enableExecuteCommand"], "Unexpected service execution mode")
    deployments = service["deployments"]
    require(len(deployments) == 1 and deployments[0]["status"] == "PRIMARY" and deployments[0]["rolloutState"] == "COMPLETED", "Rollout not healthy/completed")
    network = service["networkConfiguration"]["awsvpcConfiguration"]
    require(network["assignPublicIp"] == "DISABLED" and sorted(network["subnets"]) == sorted(d["task_subnet_ids"]) and network["securityGroups"] == [d["task_security_group"]], "Unexpected service private network")

    listed = aws("ecs", "list-tasks", "--cluster", CLUSTER, "--service-name", SERVICE, "--desired-status", "RUNNING")["taskArns"]
    require(len(listed) == 1 and listed[0].startswith(f"arn:aws:ecs:{REGION}:{ACCOUNT}:task/{CLUSTER}/"), "Expected one exact DEV task")
    described = aws("ecs", "describe-tasks", "--cluster", CLUSTER, "--tasks", *listed)
    require(not described.get("failures") and len(described["tasks"]) == 1, "Wrong task metadata")
    task = described["tasks"][0]
    require(task["group"] == f"service:{SERVICE}" and task["taskDefinitionArn"] == definition and task["lastStatus"] == "RUNNING" and task["healthStatus"] == "HEALTHY", "Wrong/unhealthy web task")
    require(len(task["containers"]) == 1 and task["containers"][0]["name"] == "web" and task["containers"][0]["imageDigest"] == digest, "Wrong running image")
    enis = [detail["value"] for attachment in task["attachments"] for detail in attachment["details"] if detail["name"] == "networkInterfaceId"]
    require(len(enis) == 1, "Expected one task ENI")
    eni = aws("ec2", "describe-network-interfaces", "--network-interface-ids", enis[0])["NetworkInterfaces"][0]
    require(not eni.get("Association") and eni["SubnetId"] in d["task_subnet_ids"] and [group["GroupId"] for group in eni["Groups"]] == [d["task_security_group"]], "Wrong/public task network")
    balancers = service["loadBalancers"]
    require(len(balancers) == 1 and balancers[0]["containerName"] == "web" and balancers[0]["containerPort"] == 3000 and balancers[0]["targetGroupArn"].startswith(f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:targetgroup/godiffy-dev-app/"), "Wrong ALB attachment")
    health = aws("elbv2", "describe-target-health", "--target-group-arn", balancers[0]["targetGroupArn"])["TargetHealthDescriptions"]
    require(len(health) == 1 and health[0]["Target"]["Id"] == eni["PrivateIpAddress"] and health[0]["TargetHealth"]["State"] == "healthy", "ALB target not healthy/exact")
    subprocess.run(["terraform", "-chdir=terraform/environments/dev", "untaint", ADDRESS], check=True, timeout=120)
    print("Verified original healthy DEV service creation, private task, immutable image and ALB target; cleared only failed-read taint without replacement/deletion.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-digest", required=True)
    main(parser.parse_args().image_digest)
