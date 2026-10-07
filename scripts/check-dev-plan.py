"""Fail-closed audit of DEV Actions plans. No deletes/replacements or unrelated resources."""
import argparse
import collections
import hashlib
import json
import subprocess
from pathlib import Path

TAGS = {"Project": "godiffy", "Environment": "dev", "ManagedBy": "terraform", "Purpose": "cloudpay-technical-assessment"}
TYPES = {
    "aws_vpc", "aws_internet_gateway", "aws_subnet", "aws_route_table", "aws_route", "aws_route_table_association",
    "aws_security_group", "aws_vpc_endpoint", "aws_vpc_security_group_ingress_rule", "aws_vpc_security_group_egress_rule",
    "aws_s3_bucket", "aws_s3_bucket_public_access_block", "aws_s3_bucket_ownership_controls", "aws_s3_bucket_server_side_encryption_configuration",
    "aws_s3_bucket_versioning", "aws_s3_bucket_cors_configuration", "aws_s3_bucket_policy", "aws_s3_bucket_lifecycle_configuration",
    "aws_db_instance", "aws_db_parameter_group", "aws_db_subnet_group", "aws_secretsmanager_secret", "aws_ecr_repository", "aws_ecr_lifecycle_policy",
    "aws_ecs_cluster", "aws_cloudwatch_log_group", "aws_iam_role", "aws_iam_role_policy", "aws_lb", "aws_lb_target_group", "aws_lb_listener",
    "aws_sns_topic", "aws_sns_topic_policy", "aws_cloudwatch_metric_alarm", "aws_ecs_task_definition", "aws_ecs_service",
    "aws_appautoscaling_target", "aws_appautoscaling_policy",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def audit(plan, phase):
    expressions = plan["configuration"]["provider_config"]["aws"]["expressions"]
    require(expressions["region"]["constant_value"] == "eu-west-2", "Wrong region")
    require(expressions["allowed_account_ids"]["constant_value"] == ["218549829565"], "Wrong account guard")
    changes, counts = [], {"add": 0, "change": 0, "delete": 0, "import": 0}
    for resource in plan.get("resource_changes", []):
        if resource["mode"] == "data":
            require(resource["type"] == "aws_ecr_image" and resource["address"].startswith("module.godiffy."), "Unexpected data dependency")
            continue
        actions = resource["change"]["actions"]
        require(actions in (["no-op"], ["create"], ["update"]), "STOP: deletion or replacement")
        before = resource["change"].get("before") or {}
        after = resource["change"].get("after") or {}
        is_ci = resource["type"] in ("aws_iam_policy", "aws_iam_role_policy_attachment") and resource["address"].startswith(("aws_iam_policy.ci_scopes[", "aws_iam_role_policy_attachment.dev_ci["))
        if is_ci:
            require(actions == ["no-op"], "STOP: CI cannot edit its own permissions/boundaries")
            if resource["type"] == "aws_iam_policy":
                require(after["name"].startswith("godiffy-dev-ci-") or after["name"].startswith("godiffy-dev-boundary-"), "Unexpected IAM policy")
            else:
                require(after["role"] == "cloudpay-demo-github-actions" and after["policy_arn"].startswith("arn:aws:iam::218549829565:policy/godiffy-dev-ci-"), "Unexpected CI attachment")
        else:
            require(resource["type"] in TYPES, "Unexpected resource type")
            require(resource["address"].startswith("module.godiffy.") or resource["address"] == "aws_secretsmanager_secret.smoke", "Unexpected root resource")
        for values in (before, after):
            require(values.get("region", "eu-west-2") == "eu-west-2", "Cross-region resource")
            for field in ("name", "bucket", "identifier", "alarm_name", "repository"):
                name = values.get(field)
                if name:
                    require(name.startswith(("godiffy-dev-", "/ecs/godiffy-dev-", "/aws/rds/instance/godiffy-dev-")), "Unrelated or production resource")
            if values.get("tags_all"):
                require(all(values["tags_all"].get(key) == value for key, value in TAGS.items()), "Wrong ownership tags")
        if resource["type"] == "aws_db_instance":
            require(not after["multi_az"] and after["instance_class"] == "db.t4g.micro", "Unexpected DEV DB cost/shape")
            require(not after["publicly_accessible"] and after["storage_encrypted"] and after["manage_master_user_password"], "Unsafe DB")
        if resource["type"] == "aws_iam_role":
            require(after["name"] in [f"godiffy-dev-{kind}" for kind in ("execution", "runtime", "migration", "bootstrap")], "Unexpected role")
            require(after["permissions_boundary"] == f'arn:aws:iam::218549829565:policy/godiffy-dev-boundary-{after["name"].removeprefix("godiffy-dev-")}', "Wrong/missing role boundary")
        if resource["type"] == "aws_lb_listener":
            require(after["protocol"] == "HTTP" and after["port"] == 80, "ACM/TLS forbidden in this deployment")
        if resource["type"] == "aws_ecs_service":
            require(not after["network_configuration"][0]["assign_public_ip"], "Public task IP")
            require(after["desired_count"] == 1, "Unexpected steady-state replica cost")
        if resource["type"] == "aws_ecs_task_definition":
            require(after["family"].startswith("godiffy-dev-"), "Unrelated task definition")
            require(after["cpu"] == "256" and after["memory"] == "512", "Unexpected task cost/shape")
        if resource["type"] == "aws_s3_bucket_public_access_block":
            require(all(after[key] for key in ("block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets")), "Public image bucket")
        if resource["type"] == "aws_route":
            require(resource["address"].endswith(".aws_route.internet"), "Unexpected private internet route")
        if actions == ["create"]:
            counts["add"] += 1
        if actions == ["update"]:
            counts["change"] += 1
        if resource["change"].get("importing"):
            counts["import"] += 1
        if actions != ["no-op"] or resource["change"].get("importing"):
            changes.append({key: resource[key] for key in ("address", "type", "change")})
    values = plan.get("variables", {})
    require(values.get("app_url", {}).get("value") is None and values.get("certificate_arn", {}).get("value") is None, "Custom domains/ACM prohibited")
    release = values.get("release", {}).get("value", {})
    require(bool(release.get("service_enabled")) == (phase == "service"), "Wrong release phase")
    require(bool(release.get("bootstrap_enabled")) == (phase == "jobs"), "Wrong bootstrap phase")
    if phase == "foundations":
        require(not release.get("image_digest"), "Foundation contains an application release")
    else:
        require(release.get("bootstrap_retained") is True, "Bootstrap resources must not be deleted")
    fingerprint = hashlib.sha256(json.dumps(changes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    types = dict(sorted(collections.Counter(item["type"] for item in changes).items()))
    return {"phase": phase, **counts, "resource_types": types, "fingerprint": fingerprint}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["foundations", "jobs", "service"])
    parser.add_argument("plan", type=Path)
    parser.add_argument("--expected")
    args = parser.parse_args()
    path = args.plan.resolve(strict=True)
    result = subprocess.run(["terraform", "show", "-json", str(path)], cwd=path.parent, check=True, capture_output=True, text=True)
    evidence = audit(json.loads(result.stdout), args.phase)
    require(not args.expected or args.expected == evidence["fingerprint"], "Plan changed since review; refuse apply")
    print(json.dumps(evidence))
