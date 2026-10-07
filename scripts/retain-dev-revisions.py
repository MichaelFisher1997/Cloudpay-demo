"""Read exact DEV task-definition history; never persist raw state or create jobs."""
import json
from pathlib import Path
import re
import subprocess

MODULE = "module.godiffy.module.application"


def revision_inputs(state):
    images, bootstrap, containers = set(), set(), {}
    for resource in state.get("resources", []):
        if resource.get("module") != MODULE or resource.get("mode", "managed") != "managed" or resource["type"] != "aws_ecs_task_definition":
            continue
        if resource["name"] not in ("web", "job"):
            raise ValueError("Unexpected DEV definition resource")
        for instance in resource["instances"]:
            key = instance.get("index_key", "")
            pattern = r"(sha256:[a-f0-9]{64})" + (r"/(bootstrap|migrate|verify)" if resource["name"] == "job" else "")
            match = re.fullmatch(pattern, key)
            if not match:
                raise ValueError("Unexpected immutable definition history")
            digest = match.group(1)
            images.add(digest)
            if resource["name"] == "web":
                value = instance["attributes"]["container_definitions"]
                definition = json.loads(value)
                if len(definition) != 1 or definition[0].get("name") != "web" or definition[0].get("image") != f"218549829565.dkr.ecr.eu-west-2.amazonaws.com/godiffy-dev-application@{digest}":
                    raise ValueError("Unexpected retained DEV web container")
                if definition[0].get("secrets"):
                    raise ValueError("Unexpected retained secret injection")
                containers[digest] = value
            if resource["name"] == "job" and match.group(2) == "bootstrap":
                bootstrap.add(digest)
    return {"retained_image_digests": sorted(images), "retained_bootstrap_image_digests": sorted(bootstrap), "retained_web_containers": containers}


if __name__ == "__main__":
    path = Path("terraform/environments/dev/ci-release.local.tfvars.json")
    inputs = json.loads(path.read_text())
    if inputs.get("release", {}).get("image_digest"):
        state = json.loads(subprocess.run(["terraform", "-chdir=terraform/environments/dev", "state", "pull"], check=True, capture_output=True, text=True, timeout=120).stdout)
        history = revision_inputs(state)
        inputs["release"].update(history)
        path.write_text(json.dumps(inputs))
        print(f"Retained {len(history['retained_image_digests'])} image digests, exact web configurations and {len(history['retained_bootstrap_image_digests'])} actual initialization digests; no raw state or secret values persisted.")
