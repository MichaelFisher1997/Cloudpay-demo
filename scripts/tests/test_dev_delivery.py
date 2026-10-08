import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


def load(filename):
    spec = importlib.util.spec_from_file_location(filename.replace("-", "_"), Path(__file__).parents[1] / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit_module = load("check-dev-plan.py")
policies_module = load("ci-policies.py")
job_module = load("run-dev-job.py")
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
        for name in ("dev-deploy.yml", "dev-image.yml"):
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


class SimplifiedWorkflowTests(unittest.TestCase):
    def test_validation_checks_dev_pushes_and_master_prs_without_aws_credentials(self):
        root = Path(__file__).parents[2]
        workflow = (root / ".github/workflows/validate.yml").read_text()
        self.assertIn("  pull_request:\n    branches: [master]", workflow)
        self.assertIn("  push:\n    branches: [dev]", workflow)
        self.assertNotIn("  push:\n    branches: [master]", workflow)
        self.assertNotIn("id-token: write", workflow)
        self.assertNotIn("configure-aws-credentials", workflow)

    def test_aws_workflows_allow_only_dev_and_keep_existing_role(self):
        root = Path(__file__).parents[2]
        for name in ("dev-deploy.yml", "dev-image.yml", "aws-oidc-check.yml"):
            workflow = (root / ".github/workflows" / name).read_text()
            self.assertIn("github.repository == 'MichaelFisher1997/Cloudpay-demo' && github.ref == 'refs/heads/dev'", workflow)
            self.assertIn("role-to-assume: arn:aws:iam::218549829565:role/cloudpay-demo-github-actions", workflow)
            self.assertNotIn("refs/heads/master", workflow)
            self.assertNotIn("terraform/environments/prod", workflow)

    def test_oidc_trust_is_exact_dev_subject_without_more_permissions(self):
        root = Path(__file__).parents[2]
        policy = json.loads((root / "aws/github-actions-trust-policy.json").read_text())
        self.assertEqual(policy, {
            "Version": "2012-10-17",
            "Statement": [{
                "Sid": "GitHubActionsDevOnly",
                "Effect": "Allow",
                "Principal": {"Federated": "arn:aws:iam::218549829565:oidc-provider/token.actions.githubusercontent.com"},
                "Action": "sts:AssumeRoleWithWebIdentity",
                "Condition": {"StringEquals": {
                    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                    "token.actions.githubusercontent.com:sub": "repo:MichaelFisher1997@91565606/Cloudpay-demo@1407927569:ref:refs/heads/dev",
                }},
            }],
        })

    def test_service_release_preserves_history_without_historical_repair_or_reset(self):
        root = Path(__file__).parents[2]
        workflow = (root / ".github/workflows/dev-deploy.yml").read_text()
        self.assertIn("python3 scripts/retain-dev-revisions.py", workflow)
        self.assertIn("python3 scripts/check-dev-plan.py", workflow)
        self.assertIn("python3 scripts/run-dev-job.py migrate", workflow)
        for obsolete in ("repair_failed_", "repair-dev-", "reset_dev_data", "--reset-dev-data", "SMOKE_SECRET_ARN"):
            self.assertNotIn(obsolete, workflow)
        self.assertFalse((root / ".github/workflows/dev-verify.yml").exists())
