"""Actions-only DEV inventory, private networking, observability and recovery checks.

Never dumps log messages, secret values, state or application credentials.
Task replacement stops only a running task belonging to the exact DEV web service.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess

ACCOUNT = "218549829565"
REGION = "eu-west-2"
CLUSTER = "godiffy-dev-cluster"
SERVICE = "godiffy-dev-web"
TAGS = {"Project": "godiffy", "Environment": "dev", "ManagedBy": "terraform", "Purpose": "cloudpay-technical-assessment"}


def aws(*args, denied=False):
    result = subprocess.run(["aws", "--region", REGION, "--no-cli-pager", *args, "--output", "json"], capture_output=True, text=True, timeout=660)
    if denied:
        # stdout could contain a secret if the boundary unexpectedly fails. It is
        # discarded without parsing, persisting or logging in that case.
        require(result.returncode != 0 and "AccessDeniedException" in result.stderr, "Expected IAM secret denial")
        return {}
    require(result.returncode == 0, f"AWS check failed: {' '.join(args[:2])}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main(outputs, replace):
    raw = json.loads(outputs.read_text())
    d = raw["deployment"]["value"]
    require(d["account_id"] == ACCOUNT and d["region"] == REGION and d["environment"] == "dev", "Wrong deployment target")
    require(d["cluster_name"] == CLUSTER and d["service_name"] == SERVICE, "Wrong service target")
    identity = aws("sts", "get-caller-identity")
    require(identity["Account"] == ACCOUNT and f":assumed-role/cloudpay-demo-github-actions/" in identity["Arn"], "Expected GitHub OIDC role")
    results = {}

    def tasks():
        listed = aws("ecs", "list-tasks", "--cluster", CLUSTER, "--service-name", SERVICE, "--desired-status", "RUNNING")["taskArns"]
        require(len(listed) == 1, "Expected one steady-state web task")
        values = aws("ecs", "describe-tasks", "--cluster", CLUSTER, "--tasks", *listed)["tasks"]
        require(len(values) == 1 and values[0]["group"] == f"service:{SERVICE}", "Unexpected task membership")
        require(values[0]["lastStatus"] == "RUNNING" and values[0]["healthStatus"] == "HEALTHY", "Task unhealthy")
        return values[0]

    task = tasks()
    enis = [detail["value"] for attachment in task["attachments"] for detail in attachment["details"] if detail["name"] == "networkInterfaceId"]
    require(len(enis) == 1, "Expected one task ENI")
    eni = aws("ec2", "describe-network-interfaces", "--network-interface-ids", enis[0])["NetworkInterfaces"][0]
    require(not eni.get("Association") and eni["SubnetId"] in d["task_subnet_ids"], "Public or unexpected task network")
    require([group["GroupId"] for group in eni["Groups"]] == [d["task_security_group"]], "Unexpected task security group")
    vpc = eni["VpcId"]
    endpoints = aws("ec2", "describe-vpc-endpoints", "--filters", f"Name=vpc-id,Values={vpc}")["VpcEndpoints"]
    require(len(endpoints) == 5 and all(endpoint["State"] == "available" for endpoint in endpoints), "Endpoint inventory mismatch")
    require({endpoint["ServiceName"] for endpoint in endpoints} == {f"com.amazonaws.{REGION}.{name}" for name in ("ecr.api", "ecr.dkr", "logs", "secretsmanager", "s3")}, "Unexpected endpoint service")
    require(all(endpoint.get("PrivateDnsEnabled") for endpoint in endpoints if endpoint["VpcEndpointType"] == "Interface"), "Missing endpoint private DNS")
    routes = aws("ec2", "describe-route-tables", "--filters", f"Name=vpc-id,Values={vpc}")["RouteTables"]
    for table in routes:
        tag_map = {tag["Key"]: tag["Value"] for tag in table.get("Tags", [])}
        name = tag_map.get("Name", "")
        if "tasks-" in name or "database-isolated" in name:
            require(not any(route.get("DestinationCidrBlock") == "0.0.0.0/0" or route.get("NatGatewayId") for route in table["Routes"]), "Unexpected private internet route")
    results["private_endpoint_only_task"] = "pass"

    db = aws("rds", "describe-db-instances", "--db-instance-identifier", "godiffy-dev-postgres")["DBInstances"][0]
    require(db["DBInstanceStatus"] == "available" and db["EngineVersion"] == "17.9", "DB not ready/pinned")
    require(db["DBInstanceClass"] == "db.t4g.micro" and not db["MultiAZ"] and not db["PubliclyAccessible"], "Unexpected DEV DB shape")
    require(db["StorageEncrypted"] and db["DeletionProtection"] and db["BackupRetentionPeriod"] == 7 and db.get("LatestRestorableTime"), "DB protections/backups missing")
    require(db["MasterUserSecret"]["SecretStatus"] == "active", "Managed master secret not active")
    results["database_and_backup_metadata"] = "pass"

    for kind in ("runtime", "migration", "master"):
        aws("secretsmanager", "get-secret-value", "--secret-id", d[f"{kind}_secret_arn"], denied=True)
    results["ci_denied_application_and_master_secrets"] = "pass"

    bucket = d["image_bucket_name"]
    require(bucket == f"godiffy-dev-images-{ACCOUNT}-{REGION}", "Wrong image bucket")
    controls = aws("s3api", "get-public-access-block", "--bucket", bucket)["PublicAccessBlockConfiguration"]
    require(all(controls.values()), "Public image bucket")
    require(aws("s3api", "get-bucket-versioning", "--bucket", bucket)["Status"] == "Enabled", "Unversioned bucket")
    cors = aws("s3api", "get-bucket-cors", "--bucket", bucket)["CORSRules"]
    require(len(cors) == 1 and cors[0]["AllowedOrigins"] == [d["application_origin"]], "Wrong browser origin")
    results["private_versioned_exact_origin_bucket"] = "pass"

    groups = aws("logs", "describe-log-groups", "--log-group-name-prefix", "/ecs/godiffy-dev-application")["logGroups"]
    require(len(groups) == 1 and groups[0]["retentionInDays"] == 7, "Wrong app log retention")
    streams = aws("logs", "describe-log-streams", "--log-group-name", d["log_group_name"])["logStreams"]
    require(any(stream.get("lastEventTimestamp") for stream in streams), "No application/job logs")
    # Presence/retention only: messages are never dumped by this workflow.
    results["logs_present_and_bounded"] = "pass"
    alarm_names = [f"godiffy-dev-{name}" for name in ("alb-target-errors", "alb-errors", "alb-unhealthy-targets", "database-cpu", "database-storage", "database-connections", "service-memory", "service-cpu", "service-healthy-targets")]
    alarms = aws("cloudwatch", "describe-alarms", "--alarm-names", *alarm_names)["MetricAlarms"]
    require(len(alarms) == 9 and all(alarm["ActionsEnabled"] and alarm["AlarmActions"] == [d["alarm_topic_arn"]] for alarm in alarms), "Alarm routing mismatch")
    results["nine_alarms_routed_to_dev_topic"] = "pass"
    target = aws("application-autoscaling", "describe-scalable-targets", "--service-namespace", "ecs", "--resource-ids", f"service/{CLUSTER}/{SERVICE}")["ScalableTargets"]
    require(len(target) == 1 and target[0]["MinCapacity"] == 1 and target[0]["MaxCapacity"] == 2, "Scaling bounds mismatch")
    results["scaling_bounds_one_to_two"] = "pass"
    now = datetime.now(timezone.utc)
    points = aws("cloudwatch", "get-metric-statistics", "--namespace", "AWS/ECS", "--metric-name", "CPUUtilization", "--dimensions", f"Name=ClusterName,Value={CLUSTER}", f"Name=ServiceName,Value={SERVICE}", "--start-time", (now - timedelta(minutes=30)).isoformat(), "--end-time", now.isoformat(), "--period", "60", "--statistics", "Average")["Datapoints"]
    results["ecs_cpu_metric"] = "pass" if points else "pending_metric_latency"

    if replace:
        arn = task["taskArn"]
        require(arn.startswith(f"arn:aws:ecs:{REGION}:{ACCOUNT}:task/{CLUSTER}/"), "Unexpected recovery task ARN")
        aws("ecs", "stop-task", "--cluster", CLUSTER, "--task", arn, "--reason", "Authorized Godiffy DEV recovery verification")
        aws("ecs", "wait", "tasks-stopped", "--cluster", CLUSTER, "--tasks", arn)
        aws("ecs", "wait", "services-stable", "--cluster", CLUSTER, "--services", SERVICE)
        replacement = tasks()
        require(replacement["taskArn"] != arn, "Task not replaced")
        results["single_task_replacement"] = "pass"
        results["replacement_task"] = replacement["taskArn"]
    print(json.dumps({"outcome": "pass", "checks": results, "scalable_target_arn": target[0]["ScalableTargetARN"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outputs", type=Path, default=Path("terraform/environments/dev/deployment.json"))
    parser.add_argument("--replace-task", action="store_true")
    args = parser.parse_args()
    main(args.outputs, args.replace_task)
