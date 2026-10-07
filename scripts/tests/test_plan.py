import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("check_plan", Path(__file__).parents[1] / "check-plan.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PlanAuditTests(unittest.TestCase):
    def setUp(self):
        self.plan = {
            "configuration": {"provider_config": {"aws": {"expressions": {
                "region": {"constant_value": "eu-west-2"},
                "allowed_account_ids": {"constant_value": ["218549829565"]},
            }}}},
            "resource_changes": [{
                "address": "module.godiffy.module.networking.aws_vpc.this", "mode": "managed", "type": "aws_vpc",
                "change": {"actions": ["create"], "after": {"region": "eu-west-2", "tags_all": {"Project": "godiffy", "Environment": "dev"}}},
            }],
            "planned_values": {"outputs": {"deployment": {"value": {"service_enabled": False, "job_task_definitions": {}}}}},
        }

    def test_safe_create(self):
        self.assertEqual(module.audit(self.plan, "dev"), {"aws_vpc": 1})

    def test_reject_delete_or_replace(self):
        for actions in (["delete"], ["delete", "create"], ["update"]):
            changed = copy.deepcopy(self.plan)
            changed["resource_changes"][0]["change"]["actions"] = actions
            with self.assertRaises(AssertionError):
                module.audit(changed, "dev")

    def test_reject_unrelated_or_secret_resource(self):
        for resource in ("aws_nat_gateway", "aws_secretsmanager_secret_version", "aws_iam_policy_attachment", "aws_ecs_service"):
            changed = copy.deepcopy(self.plan)
            changed["resource_changes"][0]["type"] = resource
            with self.assertRaises(AssertionError):
                module.audit(changed, "dev")

    def test_reject_other_account(self):
        self.plan["configuration"]["provider_config"]["aws"]["expressions"]["allowed_account_ids"]["constant_value"] = ["000000000000"]
        with self.assertRaises(AssertionError):
            module.audit(self.plan, "dev")

    def test_reject_other_environment(self):
        with self.assertRaises(AssertionError):
            module.audit(self.plan, "prod")

    def test_reject_unrelated_name(self):
        self.plan["resource_changes"][0]["change"]["after"]["name"] = "another-project-vpc"
        with self.assertRaises(AssertionError):
            module.audit(self.plan, "dev")
