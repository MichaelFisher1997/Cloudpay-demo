"""Fail closed on incomplete or critical/high OS findings for the exact DEV digest."""
import argparse
import json
from pathlib import Path
import re
import subprocess

ACCOUNT = "218549829565"
REGION = "eu-west-2"
REPOSITORY = "godiffy-dev-application"


def audit_scan(scan, digest):
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError("Expected immutable digest")
    if scan.get("registryId") != ACCOUNT or scan.get("repositoryName") != REPOSITORY or scan.get("imageId", {}).get("imageDigest") != digest:
        raise ValueError("Wrong scan target")
    if scan.get("imageScanStatus", {}).get("status") != "COMPLETE" or "imageScanFindings" not in scan:
        raise ValueError("Image OS scan must complete before release")
    counts = scan["imageScanFindings"].get("findingSeverityCounts", {})
    if any(not isinstance(count, int) or isinstance(count, bool) or count < 0 for count in counts.values()):
        raise ValueError("Invalid severity counts")
    result = {"digest": digest, "scan_status": "COMPLETE", "severity_counts": counts}
    if counts.get("CRITICAL", 0) or counts.get("HIGH", 0):
        raise ValueError("Critical/high OS findings require remediation before release")
    return result


def aws(*args):
    result = subprocess.run(["aws", "--region", REGION, "--no-cli-pager", *args, "--output", "json"], capture_output=True, text=True, timeout=660)
    if result.returncode:
        raise RuntimeError("DEV image scan operation failed")
    return json.loads(result.stdout) if result.stdout.strip() else {}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Non-secret digest JSON emitted by image publication")
    digest = json.loads(parser.parse_args().image.read_text())["digest"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError("Expected immutable digest")
    identity = aws("sts", "get-caller-identity")
    if identity["Account"] != ACCOUNT or ":assumed-role/cloudpay-demo-github-actions/" not in identity["Arn"]:
        raise RuntimeError("Image verification must use the DEV Actions identity")
    aws("ecr", "wait", "image-scan-complete", "--repository-name", REPOSITORY, "--image-id", f"imageDigest={digest}")
    scan = aws("ecr", "describe-image-scan-findings", "--repository-name", REPOSITORY, "--image-id", f"imageDigest={digest}")
    print(json.dumps(audit_scan(scan, digest)))
