import copy
import importlib.util
import json
from pathlib import Path
import unittest
from datetime import datetime, timezone
from unittest.mock import patch


def load(filename):
    spec = importlib.util.spec_from_file_location(filename.replace("-", "_"), Path(__file__).parents[1] / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit_module = load("check-dev-plan.py")
policies_module = load("ci-policies.py")
repair_module = load("repair-dev-log-state.py")
verify_module = load("verify-dev.py")
db_repair_module = load("repair-dev-db-state.py")
job_module = load("run-dev-job.py")
service_repair_module = load("repair-dev-service-state.py")
scan_module = load("check-image-scan.py")
revision_module = load("retain-dev-revisions.py")


class DevDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.plan = {
            "configuration": {"provider_config": {"aws": {"expressions": {
                "region": {"constant_value": "eu-west-2"},
                "allowed_account_ids": {"constant_value": ["218549829565"]},
            }}}},
            "resource_changes": [{
                "address": "module.godiffy.module.networking.aws_vpc.this", "mode": "managed", "type": "aws_vpc",
                "change": {"actions": ["create"], "after": {"tags_all": audit_module.TAGS, "name": "godiffy-dev-vpc"}},
            }],
        }

    def test_create_and_update_same_dev(self):
        result = audit_module.audit(self.plan, "foundations")
        self.assertEqual(result["add"], 1)
        self.assertEqual(len(result["fingerprint"]), 64)
        self.plan["resource_changes"][0]["change"]["actions"] = ["update"]
        self.assertEqual(audit_module.audit(self.plan, "foundations")["change"], 1)

    def test_all_deletions_and_replacements_rejected(self):
        for actions in (["delete"], ["delete", "create"], ["create", "delete"]):
            self.plan["resource_changes"][0]["change"]["actions"] = actions
            with self.assertRaises(ValueError):
                audit_module.audit(self.plan, "foundations")

    def test_sensitive_and_high_cost_resources_rejected(self):
        for kind in ("aws_secretsmanager_secret_version", "aws_iam_user", "aws_nat_gateway", "aws_acm_certificate", "aws_route53_record", "aws_db_proxy"):
            self.plan["resource_changes"][0]["type"] = kind
            with self.assertRaises(ValueError):
                audit_module.audit(self.plan, "foundations")

    def test_before_and_after_names_are_checked(self):
        self.plan["resource_changes"][0]["change"]["before"] = {"name": "portyard-vpc"}
        with self.assertRaises(ValueError):
            audit_module.audit(self.plan, "foundations")

    def test_no_self_iam_updates_even_with_dev_name(self):
        self.plan["resource_changes"] = [{
            "mode": "managed", "type": "aws_iam_policy", "address": 'aws_iam_policy.ci_scopes["ci-data"]',
            "change": {"actions": ["update"], "after": {"name": "godiffy-dev-ci-data"}},
        }]
        with self.assertRaises(ValueError):
            audit_module.audit(self.plan, "foundations")
        self.plan["resource_changes"][0]["change"]["actions"] = ["no-op"]
        self.assertEqual(audit_module.audit(self.plan, "foundations")["change"], 0)

    def test_plan_change_changes_fingerprint(self):
        original = audit_module.audit(self.plan, "foundations")["fingerprint"]
        self.plan["resource_changes"][0]["change"]["after"]["name"] = "godiffy-dev-vpc-new"
        self.assertNotEqual(original, audit_module.audit(self.plan, "foundations")["fingerprint"])

    def test_phase_guards(self):
        self.plan["variables"] = {"release": {"value": {"image_digest": "sha256:" + "a" * 64, "service_enabled": True}}}
        with self.assertRaises(ValueError):
            audit_module.audit(self.plan, "foundations")
        with self.assertRaises(ValueError):
            audit_module.audit(self.plan, "service")

    def test_ci_policies_fit_iam_limits_and_have_no_admin_or_secret_read(self):
        policies = policies_module.generate()
        self.assertEqual(len(policies), 9)
        for name, policy in policies.items():
            self.assertLessEqual(len(json.dumps(policy, separators=(",", ":"))), 6144)
            if not name.startswith("ci-"):
                continue
            for stmt in policy["Statement"]:
                actions = stmt["Action"] if isinstance(stmt["Action"], list) else [stmt["Action"]]
                self.assertFalse(any(action == "*" or action.endswith(":*") for action in actions))
                if "secretsmanager:GetSecretValue" in actions:
                    self.assertIn("godiffy-dev-smoke-fixtures", stmt["Resource"])
                self.assertFalse(any(action in ("iam:CreateUser", "iam:CreateAccessKey", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:CreatePolicyVersion") for action in actions))

    def test_boundary_never_wildcards_master_secret(self):
        text = json.dumps(policies_module.generate()["boundary-bootstrap"])
        self.assertNotIn("rds!db-", text)
        master = "arn:aws:secretsmanager:eu-west-2:218549829565:secret:rds!db-fixture-ABC123"
        self.assertIn(master, json.dumps(policies_module.generate(master)["boundary-bootstrap"]))
        with self.assertRaises(ValueError):
            policies_module.generate("arn:aws:secretsmanager:eu-west-2:218549829565:secret:portyard")

    def test_bootstrap_pass_can_be_removed_without_deleting_roles(self):
        policy = policies_module.generate(bootstrap_pass=False)["ci-iam"]
        stmt = next(item for item in policy["Statement"] if item["Action"] == "iam:PassRole")
        self.assertNotIn("arn:aws:iam::218549829565:role/godiffy-dev-bootstrap", stmt["Resource"])
        retired = policies_module.generate(bootstrap_pass=False)["boundary-bootstrap"]["Statement"]
        self.assertTrue(all(item["Effect"] == "Deny" for item in retired))
        self.assertEqual(retired[0]["Resource"], "*")

    def test_scaling_writes_can_be_pinned_without_restoring_bootstrap(self):
        arn = "arn:aws:application-autoscaling:eu-west-2:218549829565:scalable-target/fixture"
        policies = policies_module.generate(bootstrap_pass=False, scaling_arn=arn)
        statements = {item["Sid"]: item for item in policies["ci-control"]["Statement"]}
        for sid in ("CreateTaggedDevScalingTarget", "OnlyExistingDevScalingTarget"):
            self.assertEqual(statements[sid]["Resource"], arn)
        self.assertTrue(all(item["Effect"] == "Deny" for item in policies["boundary-bootstrap"]["Statement"]))
        self.assertNotIn("godiffy-dev-bootstrap", json.dumps(next(item for item in policies["ci-iam"]["Statement"] if item["Sid"] == "PassOnlyDevECSTaskRoles")))
        with self.assertRaises(ValueError):
            policies_module.generate(bootstrap_pass=False, scaling_arn="arn:aws:application-autoscaling:eu-west-1:218549829565:scalable-target/fixture")

    def test_generated_policies_are_current(self):
        for name, policy in policies_module.generate().items():
            committed = json.loads((Path(__file__).parents[2] / "aws/ci/policies" / f"{name}.json").read_text())
            # Exact master/scaling metadata and retirement are deliberate later
            # human bootstrap stages, while baseline policies remain testable.
            if name not in ("boundary-bootstrap", "ci-iam", "ci-control"):
                self.assertEqual(committed, policy)

    def test_ecs_read_apis_use_supported_cluster_conditions(self):
        statements = {item["Sid"]: item for item in policies_module.generate()["ci-control"]["Statement"]}
        listed = statements["ListOnlyDevClusterTasks"]
        self.assertEqual(listed["Resource"], "*")
        self.assertEqual(listed["Condition"]["ArnEquals"]["ecs:cluster"], "arn:aws:ecs:eu-west-2:218549829565:cluster/godiffy-dev-cluster")
        self.assertEqual(statements["RegionalTaskDefinitionMetadata"]["Action"], "ecs:DescribeTaskDefinition")
        self.assertEqual(statements["RegionalTaskDefinitionMetadata"]["Resource"], "*")
        deployment = statements["OnlyDevDeploymentStatus"]
        self.assertEqual(deployment["Action"], ["ecs:ListServiceDeployments", "ecs:DescribeServiceDeployments"])
        self.assertTrue(all("/godiffy-dev-cluster/godiffy-dev-web" in arn for arn in deployment["Resource"]))


class EmptyLogRepairTests(unittest.TestCase):
    def run_repair(self, *, tainted=True, streams=False, owned=True, recent=True):
        state = {"resources": [{"module": "module.godiffy.module.database", "type": "aws_cloudwatch_log_group", "name": "postgresql", "instances": [{"status": "tainted" if tainted else "ready", "attributes": {"name": repair_module.NAME}}]}]}
        responses = [
            {"Account": "218549829565", "Arn": "arn:aws:sts::218549829565:assumed-role/cloudpay-demo-github-actions/test"},
            {"logGroups": [{"logGroupName": repair_module.NAME, "creationTime": datetime.now(timezone.utc).timestamp() * 1000 if recent else 0, "storedBytes": 0}]},
            {"tags": repair_module.TAGS if owned else {}},
            {"logStreams": [{"logStreamName": "existing"}] if streams else []},
        ]
        with patch.object(repair_module, "read", return_value=state), patch.object(repair_module, "aws", side_effect=responses), patch.object(repair_module.subprocess, "run") as mutate:
            if tainted and not streams and owned and recent:
                repair_module.main()
                mutate.assert_called_once_with(["terraform", "-chdir=terraform/environments/dev", "untaint", repair_module.ADDRESS], check=True, timeout=120)
            else:
                with self.assertRaises(RuntimeError):
                    repair_module.main()
                mutate.assert_not_called()

    def test_only_failed_new_empty_owned_resource_is_retained(self):
        self.run_repair()

    def test_refuses_ordinary_nonempty_unowned_or_old_resource(self):
        for options in ({"tainted": False}, {"streams": True}, {"owned": False}, {"recent": False}):
            self.run_repair(**options)


class LogSampleTests(unittest.TestCase):
    def test_detects_credentials_sql_and_signed_urls_without_printing_them(self):
        for message in ("password: disposable", "auth_secret=fixture", "https://example.invalid/?X-Amz-Signature=fixture", "ALTER ROLE fixture PASSWORD 'disposable';", "ASIA1234567890123456"):
            self.assertIsNotNone(verify_module.SECRET_PATTERN.search(message))
        for message in ("Schema migrated", "Request failed", "Runtime role denied master and migration secrets: PASS"):
            self.assertIsNone(verify_module.SECRET_PATTERN.search(message))


class EmptyDatabaseRepairTests(unittest.TestCase):
    def run_repair(self, *, initialized=False, recent=True, jobs=False, task=False):
        state = {"resources": [{"module": "module.godiffy.module.database", "type": "aws_db_instance", "name": "this", "instances": [{"status": "tainted", "attributes": {"identifier": db_repair_module.NAME}}]}]}
        if jobs:
            state["resources"].append({"type": "aws_ecs_task_definition"})
        database = {"InstanceCreateTime": datetime.now(timezone.utc).isoformat() if recent else "2000-01-01T00:00:00+00:00", "DBInstanceStatus": "available", "DBName": "godiffy", "DBInstanceClass": "db.t4g.micro", "PubliclyAccessible": False, "MultiAZ": False, "StorageEncrypted": True, "DeletionProtection": True, "DBInstanceArn": "arn:aws:rds:eu-west-2:218549829565:db:godiffy-dev-postgres"}
        responses = [
            {"Account": "218549829565", "Arn": "arn:aws:sts::218549829565:assumed-role/cloudpay-demo-github-actions/test"},
            {"DBInstances": [database]},
            {"TagList": [{"Key": key, "Value": value} for key, value in db_repair_module.TAGS.items()]},
            {"VersionIdsToStages": {"fixture": ["AWSCURRENT"]} if initialized else {}},
            {"VersionIdsToStages": {}},
            {"taskArns": ["fixture"] if task else []},
            {"taskArns": []},
        ]
        with patch.object(db_repair_module, "read", return_value=state), patch.object(db_repair_module, "aws", side_effect=responses), patch.object(db_repair_module.subprocess, "run") as mutate:
            if not initialized and recent and not jobs and not task:
                db_repair_module.main()
                mutate.assert_called_once_with(["terraform", "-chdir=terraform/environments/dev", "untaint", db_repair_module.ADDRESS], check=True, timeout=120)
            else:
                with self.assertRaises(RuntimeError):
                    db_repair_module.main()
                mutate.assert_not_called()

    def test_retains_only_failed_new_uninitialized_db(self):
        self.run_repair()

    def test_refuses_initialized_old_or_previously_run_application(self):
        for options in ({"initialized": True}, {"recent": False}, {"jobs": True}, {"task": True}):
            self.run_repair(**options)


class ActionsJobTests(unittest.TestCase):
    def test_reset_is_opt_in_migration_override_only(self):
        self.assertEqual(job_module.job_overrides("migrate", False), {})
        self.assertEqual(job_module.job_overrides("migrate", True), {"containerOverrides": [{"name": "migrate", "environment": [{"name": "GODIFFY_DEV_RESET_CONFIRMATION", "value": "reset-godiffy-dev-data-for-clerk"}]}]})
        for job in ("bootstrap", "verify", "web"):
            with self.assertRaises(RuntimeError):
                job_module.job_overrides(job, True)

    def test_only_actions_may_run_private_jobs(self):
        target = {"account_id": "218549829565", "region": "eu-west-2", "environment": "dev", "cluster_name": "godiffy-dev-cluster"}
        identity = {"Account": "218549829565", "Arn": "arn:aws:sts::218549829565:assumed-role/cloudpay-demo-github-actions/test"}
        job_module.validate_target(target, identity)
        for arn in ("arn:aws:sts::218549829565:assumed-role/AWSReservedSSO_PortyardAdministrator_fixture/michael", "arn:aws:iam::218549829565:user/fixture"):
            with self.assertRaises(RuntimeError):
                job_module.validate_target(target, {**identity, "Arn": arn})
        with self.assertRaises(RuntimeError):
            job_module.validate_target({**target, "environment": "prod"}, identity)


class HealthyServiceRepairTests(unittest.TestCase):
    def run_repair(self, *, tainted=True, original=True, owned=True, image=True, private=True, healthy=True, actions=True, exact=True):
        m = service_repair_module
        digest = "sha256:" + "a" * 64
        definition = f"arn:aws:ecs:{m.REGION}:{m.ACCOUNT}:task-definition/{m.SERVICE}:1"
        network = {"task_subnet_ids": ["subnet-fixture"], "task_security_group": "sg-fixture"}
        state = {"resources": [
            {"module": "module.godiffy.module.application", "type": "aws_ecs_service", "name": "this", "instances": [{"index_key": 0, "status": "tainted" if tainted else "ready", "attributes": {"id": m.SERVICE_ARN if exact else "arn:aws:ecs:eu-west-2:218549829565:service/portyard/web"}}]},
            {"module": "module.godiffy.module.application", "type": "aws_ecs_task_definition", "name": "web", "instances": [{"index_key": digest, "attributes": {"arn": definition}}]},
        ], "outputs": {"deployment": {"value": {"account_id": m.ACCOUNT, "region": m.REGION, "environment": "dev", "image_digest": digest, **network}}}}
        service = {"createdAt": m.APPROVED_CREATION.isoformat() if original else "2000-01-01T00:00:00+00:00", "serviceArn": m.SERVICE_ARN, "clusterArn": m.CLUSTER_ARN, "status": "ACTIVE", "tags": [{"key": key, "value": value} for key, value in m.TAGS.items()] if owned else [], "desiredCount": 1, "runningCount": 1, "pendingCount": 0, "taskDefinition": definition, "launchType": "FARGATE", "enableExecuteCommand": False, "deployments": [{"status": "PRIMARY", "rolloutState": "COMPLETED"}], "networkConfiguration": {"awsvpcConfiguration": {"assignPublicIp": "DISABLED" if private else "ENABLED", "subnets": network["task_subnet_ids"], "securityGroups": [network["task_security_group"]]}}, "loadBalancers": [{"containerName": "web", "containerPort": 3000, "targetGroupArn": f"arn:aws:elasticloadbalancing:{m.REGION}:{m.ACCOUNT}:targetgroup/godiffy-dev-app/fixture"}]}
        task = {"group": f"service:{m.SERVICE}", "taskDefinitionArn": definition, "lastStatus": "RUNNING", "healthStatus": "HEALTHY", "containers": [{"name": "web", "imageDigest": digest if image else "sha256:" + "b" * 64}], "attachments": [{"details": [{"name": "networkInterfaceId", "value": "eni-fixture"}]}]}
        responses = [
            {"Account": m.ACCOUNT, "Arn": f"arn:aws:sts::{m.ACCOUNT}:assumed-role/" + ("cloudpay-demo-github-actions/test" if actions else "AWSReservedSSO_PortyardAdministrator_fixture/michael")},
            {"services": [service]}, {"taskArns": [f"arn:aws:ecs:{m.REGION}:{m.ACCOUNT}:task/{m.CLUSTER}/fixture"]}, {"tasks": [task]},
            {"NetworkInterfaces": [{"SubnetId": network["task_subnet_ids"][0], "Groups": [{"GroupId": network["task_security_group"]}], "PrivateIpAddress": "10.42.10.10"}]},
            {"TargetHealthDescriptions": [{"Target": {"Id": "10.42.10.10"}, "TargetHealth": {"State": "healthy" if healthy else "unhealthy"}}]},
        ]
        with patch.object(m, "read", return_value=state), patch.object(m, "aws", side_effect=responses), patch.object(m.subprocess, "run") as mutate:
            if all((tainted, original, owned, image, private, healthy, actions, exact)):
                m.main(digest)
                mutate.assert_called_once_with(["terraform", "-chdir=terraform/environments/dev", "untaint", m.ADDRESS], check=True, timeout=120)
            else:
                with self.assertRaises(RuntimeError):
                    m.main(digest)
                mutate.assert_not_called()

    def test_only_verified_exact_healthy_failed_read_service_is_retained(self):
        self.run_repair()

    def test_refuses_ordinary_other_creation_unowned_public_wrong_image_or_unhealthy_service(self):
        for key in ("tainted", "original", "owned", "image", "private", "healthy", "actions", "exact"):
            self.run_repair(**{key: False})


class ImageScanTests(unittest.TestCase):
    def setUp(self):
        self.digest = "sha256:" + "a" * 64
        self.scan = {"registryId": "218549829565", "repositoryName": "godiffy-dev-application", "imageId": {"imageDigest": self.digest}, "imageScanStatus": {"status": "COMPLETE"}, "imageScanFindings": {"findingSeverityCounts": {"LOW": 1}}}

    def test_exact_completed_scan_without_critical_high_findings(self):
        self.assertEqual(scan_module.audit_scan(self.scan, self.digest)["severity_counts"], {"LOW": 1})

    def test_refuses_wrong_target_incomplete_or_severe_findings(self):
        for key, value in (("registryId", "123456789012"), ("repositoryName", "portyard"), ("imageScanStatus", {"status": "IN_PROGRESS"}), ("imageId", {"imageDigest": "sha256:" + "b" * 64})):
            with self.assertRaises(ValueError):
                scan_module.audit_scan({**self.scan, key: value}, self.digest)
        for severity in ("HIGH", "CRITICAL"):
            with self.assertRaises(ValueError):
                scan_module.audit_scan({**self.scan, "imageScanFindings": {"findingSeverityCounts": {severity: 1}}}, self.digest)

    def test_waits_for_scan_creation_and_completion_but_is_bounded(self):
        with patch.object(scan_module, "aws", side_effect=[None, {"imageScanStatus": {"status": "IN_PROGRESS"}}, self.scan]), patch.object(scan_module.time, "sleep") as pause:
            self.assertEqual(scan_module.wait_for_scan(self.digest, attempts=3), self.scan)
            self.assertEqual(pause.call_count, 2)
        with patch.object(scan_module, "aws", return_value=None), patch.object(scan_module.time, "sleep"):
            with self.assertRaises(RuntimeError):
                scan_module.wait_for_scan(self.digest, attempts=2)

    def test_actions_tee_pipelines_use_bash_pipefail(self):
        root = Path(__file__).parents[2]
        for name in ("dev-deploy.yml", "dev-image.yml", "dev-verify.yml"):
            workflow = (root / ".github/workflows" / name).read_text()
            self.assertIn("defaults:\n  run:\n    shell: bash", workflow)


class RevisionHistoryTests(unittest.TestCase):
    def test_retains_only_actual_bootstrap_history_not_every_release(self):
        old, current = "sha256:" + "a" * 64, "sha256:" + "b" * 64
        containers = {digest: json.dumps([{"name": "web", "image": f"218549829565.dkr.ecr.eu-west-2.amazonaws.com/godiffy-dev-application@{digest}", "environment": [{"name": "INVITED_EMAILS", "value": "original@example.invalid"}]}]) for digest in (old, current)}
        state = {"resources": [
            {"module": revision_module.MODULE, "type": "aws_ecs_task_definition", "name": "web", "instances": [{"index_key": digest, "attributes": {"container_definitions": value}} for digest, value in containers.items()]},
            {"module": revision_module.MODULE, "type": "aws_ecs_task_definition", "name": "job", "instances": [{"index_key": old + "/bootstrap"}, {"index_key": current + "/migrate"}, {"index_key": current + "/verify"}]},
        ]}
        self.assertEqual(revision_module.revision_inputs(state), {"retained_image_digests": [old, current], "retained_bootstrap_image_digests": [old], "retained_web_containers": containers})
        state["resources"][1]["instances"].append({"index_key": "latest/bootstrap"})
        with self.assertRaises(ValueError):
            revision_module.revision_inputs(state)

    def test_refuses_unrelated_image_or_secret_injection_in_retained_definition(self):
        digest = "sha256:" + "a" * 64
        for container in ({"name": "web", "image": "portyard:latest"}, {"name": "web", "image": f"218549829565.dkr.ecr.eu-west-2.amazonaws.com/godiffy-dev-application@{digest}", "secrets": [{"name": "key", "valueFrom": "unexpected"}]}):
            state = {"resources": [{"module": revision_module.MODULE, "type": "aws_ecs_task_definition", "name": "web", "instances": [{"index_key": digest, "attributes": {"container_definitions": json.dumps([container])}}]}]}
            with self.assertRaises(ValueError):
                revision_module.revision_inputs(state)


class RecoveryHealthTests(unittest.TestCase):
    def test_waits_for_container_and_exact_replacement_target_health(self):
        digest = "sha256:" + "a" * 64
        task = {"taskArn": "replacement", "containers": [{"imageDigest": digest}], "healthStatus": "HEALTHY", "attachments": [{"details": [{"name": "privateIPv4Address", "value": "10.42.10.10"}]}]}
        read_health = unittest.mock.Mock(side_effect=[[{"TargetHealth": {"State": "initial"}}], [{"TargetHealth": {"State": "healthy"}}]])
        with patch.object(verify_module.time, "sleep"):
            self.assertEqual(verify_module.wait_replacement(lambda: task, read_health, "old", digest, attempts=2), task)
        read_health.assert_called_with("10.42.10.10")
        with patch.object(verify_module.time, "sleep"):
            with self.assertRaises(RuntimeError):
                verify_module.wait_replacement(lambda: task, lambda ip: [{"TargetHealth": {"State": "initial"}}], "old", digest, attempts=2)
        with self.assertRaises(RuntimeError):
            verify_module.wait_replacement(lambda: task, lambda ip: [], "old", "sha256:" + "b" * 64)
