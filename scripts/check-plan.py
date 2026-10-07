"""Read-only foundation-plan scope audit. Never prints or persists raw plan JSON."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import subprocess


def require(condition, message):
    # Unlike the assert statement, this guard remains active under python -O.
    if not condition:
        raise AssertionError(message)


def audit(plan, environment):
    prefix = f"godiffy-{environment}"
    allowed_types = {
        "aws_vpc", "aws_internet_gateway", "aws_subnet", "aws_route_table", "aws_route",
        "aws_route_table_association", "aws_security_group", "aws_vpc_endpoint",
        "aws_vpc_security_group_ingress_rule", "aws_vpc_security_group_egress_rule",
        "aws_s3_bucket", "aws_s3_bucket_public_access_block", "aws_s3_bucket_ownership_controls",
        "aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_versioning",
        "aws_s3_bucket_cors_configuration", "aws_s3_bucket_policy", "aws_s3_bucket_lifecycle_configuration",
        "aws_db_instance", "aws_db_parameter_group", "aws_db_subnet_group", "aws_secretsmanager_secret",
        "aws_ecr_repository", "aws_ecr_lifecycle_policy", "aws_ecs_cluster", "aws_cloudwatch_log_group",
        "aws_iam_role", "aws_iam_role_policy", "aws_lb", "aws_lb_target_group", "aws_lb_listener",
        "aws_sns_topic", "aws_sns_topic_policy", "aws_cloudwatch_metric_alarm",
    }
    provider = plan["configuration"]["provider_config"]["aws"]["expressions"]
    require(provider["region"]["constant_value"] == "eu-west-2", "Unexpected AWS region")
    require(provider["allowed_account_ids"]["constant_value"] == ["218549829565"], "Unexpected account guard")
    changes = plan["resource_changes"]
    require(changes, "Expected a non-empty un-applied foundation plan")
    for item in changes:
        require(item["mode"] == "managed" and item["type"] in allowed_types, "Unexpected resource type")
        require(item["address"].startswith("module.godiffy."), "Unexpected root resource")
        require(item["change"]["actions"] == ["create"], "Foundation plan must be create-only")
        after = item["change"]["after"]
        require(after.get("region", "eu-west-2") == "eu-west-2", "Cross-region resource")
        for field in ("name", "bucket", "identifier", "alarm_name", "repository"):
            if after.get(field):
                name = after[field]
                require(name.startswith(prefix) or name.startswith(f"/ecs/{prefix}") or name.startswith(f"/aws/rds/instance/{prefix}"), "Non-Godiffy resource name")
        if "tags_all" in after:
            require(after["tags_all"].get("Project") == "godiffy", "Missing project tag")
            require(after["tags_all"].get("Environment") == environment, "Wrong environment tag")
        if item["type"] == "aws_db_instance":
            require(not after["publicly_accessible"] and after["storage_encrypted"], "Unsafe database")
            require(after["deletion_protection"] and not after["skip_final_snapshot"], "Missing DB protection")
            require(after["manage_master_user_password"] and after.get("password") is None, "Master password in Terraform")
            require(after["multi_az"] == (environment == "prod"), "Unexpected RDS AZ design")
        if item["type"] == "aws_subnet":
            require(not after["map_public_ip_on_launch"], "Automatic public subnet IPs")
        if item["type"] == "aws_iam_role":
            require(after["name"] in [f"{prefix}-{suffix}" for suffix in ("execution", "runtime", "migration")], "Unexpected foundation role/master privilege")
        if item["type"] == "aws_lb":
            require(after["xff_header_processing_mode"] == "append" and not after["enable_xff_client_port"], "Unsafe trusted-proxy client IP configuration")
        if item["type"] == "aws_route":
            require(item["address"].endswith(".aws_route.internet"), "Unexpected internet route")
        if item["type"] == "aws_s3_bucket_public_access_block":
            require(all(after[key] for key in ("block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets")), "Public bucket")
    deployment = plan["planned_values"]["outputs"]["deployment"].get("value")
    if deployment is None:
        deployment = plan["output_changes"]["deployment"]["after"]
    require(deployment["service_enabled"] is False and deployment["job_task_definitions"] == {}, "Placeholder application release")
    return dict(sorted(collections.Counter(item["type"] for item in changes).items()))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("environment", choices=["dev", "prod"])
    parser.add_argument("plan", type=Path)
    args = parser.parse_args()
    path = args.plan.resolve(strict=True)
    result = subprocess.run(["terraform", "show", "-json", str(path)], cwd=path.parent, check=True, capture_output=True, text=True)
    counts = audit(json.loads(result.stdout), args.environment)
    print(json.dumps({"environment": args.environment, "additions": sum(counts.values()), "changes": 0, "deletions": 0, "resource_types": counts, "plan_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}, indent=2))
