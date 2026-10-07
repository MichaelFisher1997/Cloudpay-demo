"""Generate DEV-only human-bootstrapped CI policies; no AWS calls or secret values."""
import argparse
import json
from pathlib import Path

ACCOUNT = "218549829565"
REGION = "eu-west-2"
PREFIX = "godiffy-dev"
TAGS = {"Project": "godiffy", "Environment": "dev", "ManagedBy": "terraform", "Purpose": "cloudpay-technical-assessment"}
DESTINATION = Path(__file__).resolve().parents[1] / "aws/ci/policies"


def statement(sid, actions, resources, condition=None, effect="Allow"):
    result = {"Sid": sid, "Effect": effect, "Action": actions, "Resource": resources}
    if condition:
        result["Condition"] = condition
    return result


def document(*statements):
    return {"Version": "2012-10-17", "Statement": list(statements)}


def generate(master_arn=None, bootstrap_pass=True, scaling_arn=None):
    if master_arn and not master_arn.startswith(f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:rds!db-"):
        raise ValueError("Unexpected dedicated RDS-managed secret ARN")
    if scaling_arn and not scaling_arn.startswith(f"arn:aws:application-autoscaling:{REGION}:{ACCOUNT}:scalable-target/"):
        raise ValueError("Unexpected dedicated scalable target ARN")
    regional = {"StringEquals": {"aws:RequestedRegion": REGION}}
    requested = {"StringEquals": {f"aws:RequestTag/{key}": value for key, value in TAGS.items()}}
    existing = {"StringEquals": {"aws:ResourceTag/Project": "godiffy", "aws:ResourceTag/Environment": "dev"}}
    ec2_types = ["vpc", "subnet", "route-table", "internet-gateway", "security-group", "security-group-rule", "vpc-endpoint"]
    ec2_resources = [f"arn:aws:ec2:{REGION}:{ACCOUNT}:{kind}/*" for kind in ec2_types]
    ec2_creates = ["CreateVpc", "CreateSubnet", "CreateRouteTable", "CreateInternetGateway", "CreateSecurityGroup", "CreateVpcEndpoint", "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress"]
    network = document(
        statement("RegionalDiscovery", [f"ec2:{name}" for name in ["DescribeVpcs", "DescribeVpcAttribute", "DescribeSubnets", "DescribeRouteTables", "DescribeInternetGateways", "DescribeSecurityGroups", "DescribeSecurityGroupRules", "DescribeVpcEndpoints", "DescribeVpcEndpointServices", "DescribePrefixLists", "DescribeManagedPrefixLists", "DescribeAvailabilityZones", "DescribeTags", "DescribeNetworkInterfaces"]], "*", regional),
        statement("CreateTaggedDevNetwork", [f"ec2:{name}" for name in ec2_creates[:6]], ec2_resources, requested),
        statement("TaggedDevParents", ["ec2:CreateSubnet", "ec2:CreateRouteTable", "ec2:CreateSecurityGroup", "ec2:CreateVpcEndpoint"], f"arn:aws:ec2:{REGION}:{ACCOUNT}:vpc/*", existing),
        statement("OnlyTaggedDevEndpointAttachments", "ec2:CreateVpcEndpoint", [f"arn:aws:ec2:{REGION}:{ACCOUNT}:{kind}/*" for kind in ("subnet", "security-group", "route-table")], existing),
        statement("CreateTaggedDevSecurityRules", ["ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress"], f"arn:aws:ec2:{REGION}:{ACCOUNT}:security-group-rule/*", requested),
        statement("ModifyOnlyDevNetwork", ["ec2:ModifyVpcAttribute", "ec2:AttachInternetGateway", "ec2:AssociateRouteTable", "ec2:CreateRoute", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:ModifyVpcEndpoint"], ec2_resources, existing),
        statement("CreateTimeNetworkTags", "ec2:CreateTags", ec2_resources, {"StringEquals": {"ec2:CreateAction": ec2_creates}}),
        statement("MaintainDevNetworkTags", "ec2:CreateTags", ec2_resources, existing),
    )
    bucket = f"arn:aws:s3:::{PREFIX}-images-{ACCOUNT}-{REGION}"
    state_bucket = f"arn:aws:s3:::godiffy-terraform-state-{ACCOUNT}-{REGION}"
    runtime = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:{PREFIX}-runtime-*"
    migration = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:{PREFIX}-migration-*"
    fixtures = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:{PREFIX}-smoke-fixtures-*"
    rds_resources = [f"arn:aws:rds:{REGION}:{ACCOUNT}:{kind}:{PREFIX}-*" for kind in ["db", "pg", "subgrp"]]
    data = document(
        statement("ReadOnlyDevStatePrefix", "s3:ListBucket", state_bucket, {"StringLike": {"s3:prefix": ["godiffy/dev/*"]}}),
        statement("ReadWriteDevState", ["s3:GetObject", "s3:PutObject"], f"{state_bucket}/godiffy/dev/terraform.tfstate"),
        statement("NativeDevLock", ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], f"{state_bucket}/godiffy/dev/terraform.tfstate.tflock"),
        statement("StateBucketLocationOnly", "s3:GetBucketLocation", state_bucket),
        statement("DedicatedImageBucketConfiguration", [f"s3:{name}" for name in ["CreateBucket", "GetBucketLocation", "GetBucketTagging", "PutBucketTagging", "GetEncryptionConfiguration", "PutEncryptionConfiguration", "GetBucketVersioning", "PutBucketVersioning", "GetBucketAcl", "GetBucketOwnershipControls", "PutBucketOwnershipControls", "GetBucketPublicAccessBlock", "PutBucketPublicAccessBlock", "GetBucketPolicy", "PutBucketPolicy", "GetBucketCORS", "PutBucketCORS", "GetLifecycleConfiguration", "PutLifecycleConfiguration", "ListBucket", "GetBucketRequestPayment", "GetBucketLogging", "GetBucketWebsite", "GetAccelerateConfiguration", "GetBucketObjectLockConfiguration", "GetReplicationConfiguration"]], bucket),
        statement("OnlyDevDatabase", [f"rds:{name}" for name in ["CreateDBInstance", "ModifyDBInstance", "DescribeDBInstances", "CreateDBSubnetGroup", "ModifyDBSubnetGroup", "DescribeDBSubnetGroups", "CreateDBParameterGroup", "ModifyDBParameterGroup", "DescribeDBParameterGroups", "DescribeDBParameters", "ListTagsForResource", "AddTagsToResource"]], rds_resources),
        statement("RegionalDatabaseDiscovery", ["rds:DescribeDBEngineVersions", "rds:DescribeOrderableDBInstanceOptions"], "*", regional),
        statement("OnlyDevSecretContainers", ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:ListSecretVersionIds", "secretsmanager:TagResource"], [runtime, migration, fixtures]),
        statement("RDSManagedSecretCreationOnly", ["secretsmanager:CreateSecret", "secretsmanager:TagResource"], f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:rds!db-*", {"StringEquals": {"aws:CalledViaLast": "rds.amazonaws.com"}, "Bool": {"aws:ViaAWSService": "true"}}),
        statement("KeyMetadataNotDecryption", "kms:DescribeKey", "*", regional),
        statement("DisposableSmokeFixturesOnly", ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"], fixtures),
    )
    repository = f"arn:aws:ecr:{REGION}:{ACCOUNT}:repository/{PREFIX}-application"
    logs = [f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/ecs/{PREFIX}-application:*", f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/rds/instance/{PREFIX}-postgres/postgresql:*"]
    lb_resources = [f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:{kind}/{PREFIX}-*/*" for kind in ["loadbalancer/app", "targetgroup", "listener/app", "listener-rule/app"]]
    services = document(
        statement("OnlyDevRepository", [f"ecr:{name}" for name in ["CreateRepository", "DescribeRepositories", "ListTagsForResource", "TagResource", "PutLifecyclePolicy", "GetLifecyclePolicy", "GetRepositoryPolicy", "PutImageScanningConfiguration", "DescribeImages", "DescribeImageScanFindings", "BatchCheckLayerAvailability", "InitiateLayerUpload", "UploadLayerPart", "CompleteLayerUpload", "PutImage", "BatchGetImage", "GetDownloadUrlForLayer"]], repository),
        statement("ECRAuthentication", "ecr:GetAuthorizationToken", "*", regional),
        statement("ELBReadOnlyDiscovery", [f"elasticloadbalancing:{name}" for name in ["DescribeLoadBalancers", "DescribeLoadBalancerAttributes", "DescribeTargetGroups", "DescribeTargetGroupAttributes", "DescribeListeners", "DescribeListenerAttributes", "DescribeTags", "DescribeTargetHealth"]], "*", regional),
        statement("CreateTaggedDevALB", ["elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:CreateListener"], lb_resources, requested),
        statement("DevLoadBalancerUpdates", ["elasticloadbalancing:ModifyLoadBalancerAttributes", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyListener", "elasticloadbalancing:AddTags"], lb_resources),
        statement("OnlyDevLogs", ["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:TagResource", "logs:ListTagsForResource", "logs:ListTagsLogGroup", "logs:GetLogEvents", "logs:FilterLogEvents", "logs:DescribeLogStreams"], logs + [arn.removesuffix(":*") for arn in logs]),
        statement("RegionalLogDiscovery", "logs:DescribeLogGroups", "*", regional),
        statement("OnlyDevAlarms", ["cloudwatch:PutMetricAlarm", "cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource", "cloudwatch:TagResource"], f"arn:aws:cloudwatch:{REGION}:{ACCOUNT}:alarm:{PREFIX}-*"),
        statement("RegionalMetricsRead", ["cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics"], "*", regional),
        statement("OnlyDevAlarmTopic", ["sns:CreateTopic", "sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:TagResource", "sns:ListTagsForResource", "sns:ListSubscriptionsByTopic"], f"arn:aws:sns:{REGION}:{ACCOUNT}:{PREFIX}-alarms"),
    )
    cluster = f"arn:aws:ecs:{REGION}:{ACCOUNT}:cluster/{PREFIX}-cluster"
    task_definitions = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/{PREFIX}-*:*"
    task_resources = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task/{PREFIX}-cluster/*"
    service = f"arn:aws:ecs:{REGION}:{ACCOUNT}:service/{PREFIX}-cluster/{PREFIX}-web"
    roles = {kind: f"arn:aws:iam::{ACCOUNT}:role/{PREFIX}-{kind}" for kind in ["execution", "runtime", "migration", "bootstrap"]}
    own = f"arn:aws:iam::{ACCOUNT}:role/cloudpay-demo-github-actions"
    role_statements = []
    for kind, arn in roles.items():
        boundary = f"arn:aws:iam::{ACCOUNT}:policy/{PREFIX}-boundary-{kind}"
        role_statements.append(statement(f"CreateBounded{kind.title()}Role", "iam:CreateRole", arn, {"StringEquals": {"iam:PermissionsBoundary": boundary, **{f"aws:RequestTag/{key}": value for key, value in TAGS.items()}}}))
        role_statements.append(statement(f"OnlyBounded{kind.title()}InlinePolicy", "iam:PutRolePolicy", arn, {"StringEquals": {"iam:PermissionsBoundary": boundary, "iam:ResourceTag/Project": "godiffy", "iam:ResourceTag/Environment": "dev"}}))
    iam = document(
        statement("ReadOnlyDedicatedRoles", ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies"], [own, *roles.values()]),
        statement("ReadOnlyCIAndBoundaryPolicies", ["iam:GetPolicy", "iam:GetPolicyVersion"], f"arn:aws:iam::{ACCOUNT}:policy/{PREFIX}-*"),
        *role_statements,
        statement("OnlyDevTaskTrustAndTags", ["iam:UpdateAssumeRolePolicy", "iam:TagRole"], list(roles.values())),
        statement("PassOnlyDevECSTaskRoles", "iam:PassRole", [arn for kind, arn in roles.items() if bootstrap_pass or kind != "bootstrap"], {"StringEquals": {"iam:PassedToService": "ecs-tasks.amazonaws.com"}}),
        statement("ExactlyApprovedMissingServiceRoles", "iam:CreateServiceLinkedRole", [f"arn:aws:iam::{ACCOUNT}:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS", f"arn:aws:iam::{ACCOUNT}:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/AWSServiceRoleForApplicationAutoScaling_ECSService"], {"StringEquals": {"iam:AWSServiceName": ["rds.amazonaws.com", "ecs.application-autoscaling.amazonaws.com"]}}),
    )
    control = document(
        statement("OnlyDevCluster", ["ecs:CreateCluster", "ecs:DescribeClusters", "ecs:UpdateClusterSettings", "ecs:TagResource", "ecs:ListTagsForResource", "ecs:ListTasks"], cluster),
        statement("OnlyTaggedDevTaskDefinitions", "ecs:RegisterTaskDefinition", task_definitions, requested),
        statement("OnlyDevTaskDefinitionMetadata", ["ecs:DescribeTaskDefinition", "ecs:ListTagsForResource", "ecs:TagResource"], task_definitions),
        statement("OnlyDevService", ["ecs:CreateService", "ecs:UpdateService", "ecs:DescribeServices", "ecs:ListTagsForResource", "ecs:TagResource"], service),
        statement("PrivateDevJobs", "ecs:RunTask", task_definitions, {"ArnEquals": {"ecs:cluster": cluster}}),
        statement("OnlyDevTaskStatusAndRecovery", ["ecs:DescribeTasks", "ecs:StopTask"], task_resources),
        statement("TagDevJobTasks", "ecs:TagResource", task_resources, requested),
        statement("CreateTaggedDevScalingTarget", ["application-autoscaling:RegisterScalableTarget", "application-autoscaling:TagResource"], scaling_arn or f"arn:aws:application-autoscaling:{REGION}:{ACCOUNT}:scalable-target/*", {"StringEquals": {"aws:RequestedRegion": REGION, **{f"aws:RequestTag/{key}": value for key, value in TAGS.items()}}, "StringEqualsIfExists": {"application-autoscaling:service-namespace": "ecs", "application-autoscaling:scalable-dimension": "ecs:service:DesiredCount"}, "Null": {"aws:ResourceTag/Project": "true"}}),
        statement("OnlyExistingDevScalingTarget", ["application-autoscaling:RegisterScalableTarget", "application-autoscaling:PutScalingPolicy", "application-autoscaling:TagResource"], scaling_arn or f"arn:aws:application-autoscaling:{REGION}:{ACCOUNT}:scalable-target/*", {"StringEquals": {"aws:RequestedRegion": REGION, "aws:ResourceTag/Project": "godiffy", "aws:ResourceTag/Environment": "dev"}}),
        statement("RegionalScalingRead", ["application-autoscaling:DescribeScalableTargets", "application-autoscaling:DescribeScalingPolicies", "application-autoscaling:ListTagsForResource"], "*", regional),
    )
    boundaries = {
        "execution": document(statement("ECRAuth", "ecr:GetAuthorizationToken", "*", regional), statement("DedicatedImagePull", ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], repository), statement("DedicatedLogWrites", ["logs:CreateLogStream", "logs:PutLogEvents"], logs[0])),
        "runtime": document(statement("RuntimeSecretOnly", "secretsmanager:GetSecretValue", runtime), statement("PendingUploads", ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"], f"{bucket}/pending/*"), statement("PinnedImages", ["s3:PutObject", "s3:GetObjectVersion", "s3:DeleteObjectVersion"], f"{bucket}/images/*")),
        "migration": document(statement("MigrationSecretOnly", "secretsmanager:GetSecretValue", migration)),
        "bootstrap": document(statement("OnlyInitializationSecretReads", "secretsmanager:GetSecretValue", [runtime, migration] + ([master_arn] if master_arn else [])), statement("OnlyInitializationSecretWrites", "secretsmanager:PutSecretValue", [runtime, migration])),
    }
    if not bootstrap_pass:
        # Human-controlled boundary closes the indirect CI route permanently:
        # CI cannot restore master access by re-enabling the task trust/policy.
        boundaries["bootstrap"] = document(statement("RetiredInitializationCannotReadOrWriteSecrets", ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"], "*", effect="Deny"))
    result = {f"ci-{key}": value for key, value in {"network": network, "data": data, "services": services, "control": control, "iam": iam}.items()}
    result.update({f"boundary-{key}": value for key, value in boundaries.items()})
    for name, policy in result.items():
        if len(json.dumps(policy, separators=(",", ":"))) > 6144:
            raise ValueError(f"IAM managed policy exceeds 6144 characters: {name}")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master-secret-arn")
    parser.add_argument("--restrict-bootstrap-pass", action="store_true")
    parser.add_argument("--scalable-target-arn")
    args = parser.parse_args()
    DESTINATION.mkdir(parents=True, exist_ok=True)
    for name, policy in generate(args.master_secret_arn, not args.restrict_bootstrap_pass, args.scalable_target_arn).items():
        (DESTINATION / f"{name}.json").write_text(json.dumps(policy, indent=2) + "\n")
    print("Generated nine DEV-only policies; no AWS API calls or secret values.")
