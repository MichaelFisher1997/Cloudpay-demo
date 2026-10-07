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
    def test_only_actions_may_run_private_jobs(self):
        target = {"account_id": "218549829565", "region": "eu-west-2", "environment": "dev", "cluster_name": "godiffy-dev-cluster"}
        identity = {"Account": "218549829565", "Arn": "arn:aws:sts::218549829565:assumed-role/cloudpay-demo-github-actions/test"}
        job_module.validate_target(target, identity)
        for arn in ("arn:aws:sts::218549829565:assumed-role/AWSReservedSSO_PortyardAdministrator_fixture/michael", "arn:aws:iam::218549829565:user/fixture"):
            with self.assertRaises(RuntimeError):
                job_module.validate_target(target, {**identity, "Arn": arn})
        with self.assertRaises(RuntimeError):
            job_module.validate_target({**target, "environment": "prod"}, identity)
