"""Actions-only DEV inventory, private networking, observability and recovery checks.

Never dumps log messages, secret values, state or application credentials.
Task replacement stops only a running task belonging to the exact DEV web service.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
import re
from pathlib import Path
import subprocess
import time
from importlib.util import module_from_spec, spec_from_file_location

ACCOUNT = "218549829565"
REGION = "eu-west-2"
CLUSTER = "godiffy-dev-cluster"
SERVICE = "godiffy-dev-web"
TAGS = {"Project": "godiffy", "Environment": "dev", "ManagedBy": "terraform", "Purpose": "cloudpay-technical-assessment"}
SECRET_PATTERN = re.compile(r"x-amz-(?:signature|security-token)=|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bPASSWORD\s+'|\b(?:password|auth_secret|secret_access_key|aws_session_token)[\"']?\s*[:=]\s*\S+", re.IGNORECASE)
scan_spec = spec_from_file_location("check_image_scan", Path(__file__).with_name("check-image-scan.py"))
scan_module = module_from_spec(scan_spec)
scan_spec.loader.exec_module(scan_module)


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


def wait_replacement(read_task, read_health, previous_arn, digest, attempts=40):
    for attempt in range(attempts):
        candidate = read_task()
        require(candidate["taskArn"] != previous_arn, "Task not replaced")
        require(candidate["containers"][0]["imageDigest"] == digest, "Replacement image changed")
        private_ips = [detail["value"] for attachment in candidate["attachments"] for detail in attachment["details"] if detail["name"] == "privateIPv4Address"]
        require(len(private_ips) == 1, "Unexpected replacement private IP")
        health = read_health(private_ips[0])
        if candidate["healthStatus"] == "HEALTHY" and len(health) == 1 and health[0]["TargetHealth"]["State"] == "healthy":
            return candidate
        if attempt < attempts - 1:
            time.sleep(5)
    raise RuntimeError("Replacement container/ALB health did not converge")


def main(outputs, replace):
    raw = json.loads(outputs.read_text())
    d = raw["deployment"]["value"]
    require(d["account_id"] == ACCOUNT and d["region"] == REGION and d["environment"] == "dev", "Wrong deployment target")
    require(d["cluster_name"] == CLUSTER and d["service_name"] == SERVICE, "Wrong service target")
    identity = aws("sts", "get-caller-identity")
    require(identity["Account"] == ACCOUNT and f":assumed-role/cloudpay-demo-github-actions/" in identity["Arn"], "Expected GitHub OIDC role")
    results = {}

    def tasks(healthy=True):
        listed = aws("ecs", "list-tasks", "--cluster", CLUSTER, "--service-name", SERVICE, "--desired-status", "RUNNING")["taskArns"]
        require(len(listed) == 1, "Expected one steady-state web task")
        values = aws("ecs", "describe-tasks", "--cluster", CLUSTER, "--tasks", *listed)["tasks"]
        require(len(values) == 1 and values[0]["group"] == f"service:{SERVICE}", "Unexpected task membership")
        require(values[0]["lastStatus"] == "RUNNING", "Task not running")
        require(not healthy or values[0]["healthStatus"] == "HEALTHY", "Task unhealthy")
        return values[0]

    task = tasks()
    require(len(task["containers"]) == 1 and task["containers"][0]["imageDigest"] == d["image_digest"], "Unexpected running image digest")
    results["private_immutable_ecr_pull"] = "pass"
    scan = aws("ecr", "describe-image-scan-findings", "--repository-name", "godiffy-dev-application", "--image-id", f"imageDigest={d['image_digest']}")
    results["ecr_scan"] = scan_module.audit_scan(scan, d["image_digest"])
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
    target_groups = aws("elbv2", "describe-target-groups", "--names", "godiffy-dev-app")["TargetGroups"]
    require(len(target_groups) == 1 and target_groups[0]["VpcId"] == vpc, "Unexpected ALB target group")
    health = aws("elbv2", "describe-target-health", "--target-group-arn", target_groups[0]["TargetGroupArn"])["TargetHealthDescriptions"]
    require(len(health) == 1 and health[0]["Target"]["Id"] == eni["PrivateIpAddress"] and health[0]["TargetHealth"]["State"] == "healthy", "ALB target unhealthy/unexpected")
    results["alb_healthy_private_target"] = "pass"

    db = aws("rds", "describe-db-instances", "--db-instance-identifier", "godiffy-dev-postgres")["DBInstances"][0]
    require(db["DBInstanceStatus"] == "available" and db["EngineVersion"] == "17.9", "DB not ready/pinned")
    require(db["DBInstanceClass"] == "db.t4g.micro" and not db["MultiAZ"] and not db["PubliclyAccessible"], "Unexpected DEV DB shape")
    require(db["StorageEncrypted"] and db["DeletionProtection"] and db["BackupRetentionPeriod"] == 7 and db.get("LatestRestorableTime"), "DB protections/backups missing")
    require(db["MasterUserSecret"]["SecretStatus"] == "active", "Managed master secret not active")
    results["database_and_backup_metadata"] = "pass"

    for kind in ("runtime", "migration", "master"):
        aws("secretsmanager", "get-secret-value", "--secret-id", d[f"{kind}_secret_arn"], denied=True)
    results["ci_denied_application_and_master_secrets"] = "pass"
    for kind in ("execution", "runtime", "migration", "bootstrap"):
        role = aws("iam", "get-role", "--role-name", f"godiffy-dev-{kind}")["Role"]
        boundary_arn = f"arn:aws:iam::{ACCOUNT}:policy/godiffy-dev-boundary-{kind}"
        require(role["PermissionsBoundary"]["PermissionsBoundaryArn"] == boundary_arn, "Wrong task boundary")
        if kind == "bootstrap":
            require(all(statement["Effect"] == "Deny" for statement in role["AssumeRolePolicyDocument"]["Statement"]), "Bootstrap trust not retired")
            metadata = aws("iam", "get-policy", "--policy-arn", boundary_arn)["Policy"]
            boundary = aws("iam", "get-policy-version", "--policy-arn", boundary_arn, "--version-id", metadata["DefaultVersionId"])["PolicyVersion"]["Document"]
            require(all(statement["Effect"] == "Deny" for statement in boundary["Statement"]), "Bootstrap boundary not retired")
    results["four_boundaries_and_retired_bootstrap"] = "pass"

    bucket = d["image_bucket_name"]
    require(bucket == f"godiffy-dev-images-{ACCOUNT}-{REGION}", "Wrong image bucket")
    controls = aws("s3api", "get-public-access-block", "--bucket", bucket)["PublicAccessBlockConfiguration"]
    require(all(controls.values()), "Public image bucket")
    require(aws("s3api", "get-bucket-versioning", "--bucket", bucket)["Status"] == "Enabled", "Unversioned bucket")
    ownership = aws("s3api", "get-bucket-ownership-controls", "--bucket", bucket)["OwnershipControls"]["Rules"]
    require(len(ownership) == 1 and ownership[0]["ObjectOwnership"] == "BucketOwnerEnforced", "S3 ACL ownership not disabled")
    encryption = aws("s3api", "get-bucket-encryption", "--bucket", bucket)["ServerSideEncryptionConfiguration"]["Rules"]
    require(len(encryption) == 1 and encryption[0]["ApplyServerSideEncryptionByDefault"]["SSEAlgorithm"] == "AES256", "Wrong image encryption")
    policy = json.loads(aws("s3api", "get-bucket-policy", "--bucket", bucket)["Policy"])
    tls_denials = [statement for statement in policy["Statement"] if statement.get("Effect") == "Deny" and statement.get("Condition", {}).get("Bool", {}).get("aws:SecureTransport") == "false"]
    require(len(tls_denials) == 1 and tls_denials[0]["Resource"] == [f"arn:aws:s3:::{bucket}", f"arn:aws:s3:::{bucket}/*"], "Missing exact image-bucket TLS denial")
    cors = aws("s3api", "get-bucket-cors", "--bucket", bucket)["CORSRules"]
    require(len(cors) == 1 and cors[0]["AllowedOrigins"] == [d["application_origin"]], "Wrong browser origin")
    results["private_versioned_encrypted_acl_disabled_tls_exact_origin_bucket"] = "pass"

    groups = aws("logs", "describe-log-groups", "--log-group-name-prefix", "/ecs/godiffy-dev-application")["logGroups"]
    require(len(groups) == 1 and groups[0]["retentionInDays"] == 7, "Wrong app log retention")
    streams = aws("logs", "describe-log-streams", "--log-group-name", d["log_group_name"])["logStreams"]
    require(any(stream.get("lastEventTimestamp") for stream in streams), "No application/job logs")
    # Presence/retention only: messages are never dumped by this workflow.
    results["logs_present_and_bounded"] = "pass"
    # Bounded sample, checked in memory; never print or persist log messages.
    sampled = 0
    for group_name in (d["log_group_name"], "/aws/rds/instance/godiffy-dev-postgres/postgresql"):
        sample_streams = aws("logs", "describe-log-streams", "--log-group-name", group_name, "--order-by", "LastEventTime", "--descending", "--limit", "10", "--no-paginate")["logStreams"]
        for stream in sample_streams:
            messages = aws("logs", "get-log-events", "--log-group-name", group_name, "--log-stream-name", stream["logStreamName"], "--limit", "100", "--no-paginate")["events"]
            require(not any(SECRET_PATTERN.search(event["message"]) for event in messages), "Potential secret indicator in log sample; inspect securely")
            sampled += len(messages)
    results["sampled_logs_no_secret_indicators"] = {"status": "pass", "events": sampled}
    alarm_names = [f"godiffy-dev-{name}" for name in ("alb-target-errors", "alb-errors", "alb-unhealthy-targets", "database-cpu", "database-storage", "database-connections", "service-memory", "service-cpu", "service-healthy-targets")]
    alarms = aws("cloudwatch", "describe-alarms", "--alarm-names", *alarm_names)["MetricAlarms"]
    require(len(alarms) == 9 and all(alarm["ActionsEnabled"] and alarm["AlarmActions"] == [d["alarm_topic_arn"]] for alarm in alarms), "Alarm routing mismatch")
    results["nine_alarms_routed_to_dev_topic"] = "pass"
    subscribers = aws("sns", "list-subscriptions-by-topic", "--topic-arn", d["alarm_topic_arn"])["Subscriptions"]
    results["confirmed_alarm_subscribers"] = sum(subscription["SubscriptionArn"] != "PendingConfirmation" for subscription in subscribers)
    target = aws("application-autoscaling", "describe-scalable-targets", "--service-namespace", "ecs", "--resource-ids", f"service/{CLUSTER}/{SERVICE}")["ScalableTargets"]
    require(len(target) == 1 and target[0]["MinCapacity"] == 1 and target[0]["MaxCapacity"] == 2, "Scaling bounds mismatch")
    results["scaling_bounds_one_to_two"] = "pass"
    now = datetime.now(timezone.utc)
    points = aws("cloudwatch", "get-metric-statistics", "--namespace", "AWS/ECS", "--metric-name", "CPUUtilization", "--dimensions", f"Name=ClusterName,Value={CLUSTER}", f"Name=ServiceName,Value={SERVICE}", "--start-time", (now - timedelta(minutes=30)).isoformat(), "--end-time", now.isoformat(), "--period", "60", "--statistics", "Average")["Datapoints"]
    results["ecs_cpu_metric"] = "pass" if points else "pending_metric_latency"

    if replace:
        started = time.monotonic()
        arn = task["taskArn"]
        require(arn.startswith(f"arn:aws:ecs:{REGION}:{ACCOUNT}:task/{CLUSTER}/"), "Unexpected recovery task ARN")
        aws("ecs", "stop-task", "--cluster", CLUSTER, "--task", arn, "--reason", "Authorized Godiffy DEV recovery verification")
        aws("ecs", "wait", "tasks-stopped", "--cluster", CLUSTER, "--tasks", arn)
        aws("ecs", "wait", "services-stable", "--cluster", CLUSTER, "--services", SERVICE)
        # ECS services-stable checks counts, not container/ALB health. Wait for
        # the one new private task's health explicitly before reusing sessions.
        replacement = wait_replacement(
            lambda: tasks(healthy=False),
            lambda ip: aws("elbv2", "describe-target-health", "--target-group-arn", target_groups[0]["TargetGroupArn"], "--targets", f"Id={ip},Port=3000")["TargetHealthDescriptions"],
            arn, d["image_digest"],
        )
        results["single_task_replacement"] = "pass"
        results["replacement_task"] = replacement["taskArn"]
        results["recovery_seconds"] = round(time.monotonic() - started, 1)
    print(json.dumps({"outcome": "pass", "checks": results, "task_arn": task["taskArn"], "scalable_target_arn": target[0]["ScalableTargetARN"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outputs", type=Path, default=Path("terraform/environments/dev/deployment.json"))
    parser.add_argument("--replace-task", action="store_true")
    args = parser.parse_args()
    main(args.outputs, args.replace_task)
