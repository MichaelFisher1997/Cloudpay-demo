import copy
import importlib.util
import json
from pathlib import Path
import unittest


def load(filename):
    spec = importlib.util.spec_from_file_location(filename.replace("-", "_"), Path(__file__).parents[1] / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit_module = load("check-dev-plan.py")
policies_module = load("ci-policies.py")


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

    def test_generated_policies_are_current(self):
        for name, policy in policies_module.generate().items():
            committed = json.loads((Path(__file__).parents[2] / "aws/ci/policies" / f"{name}.json").read_text())
            # Exact master/scaling metadata and retirement are deliberate later
            # human bootstrap stages, while baseline policies remain testable.
            if name not in ("boundary-bootstrap", "ci-iam", "ci-control"):
                self.assertEqual(committed, policy)
