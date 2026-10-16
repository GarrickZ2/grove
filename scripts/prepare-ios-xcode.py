#!/usr/bin/env python3
"""Install native activity targets and configure the Xcode Rust build phase."""
import json
import re
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
apple = root / "grove-ios/gen/apple"
directories = [str(Path.home() / ".cargo/bin"), "/opt/homebrew/bin", "/usr/local/bin"]
for tool in ("pnpm", "node", "cargo"):
    executable = shutil.which(tool)
    if executable:
        directories.insert(0, str(Path(executable).parent))
directories = list(dict.fromkeys(directories))
# JSON's double-quoted string is also an Xcode project string. Escape shell
# metacharacters separately before serializing the shell script.
path = ":".join(directories)
for character in ("\\", '"', "$", "`"):
    path = path.replace(character, "\\" + character)
prefix = f'export PATH="{path}:$PATH"\n'
project = apple / "grove-ios.xcodeproj/project.pbxproj"
# Regenerate with our checked-in extension overlay, retaining local signing.
old = project.read_text()
team = re.search(r'DEVELOPMENT_TEAM = "?([A-Z0-9]+)"?;', old)
config = json.loads((root / "grove-ios/tauri.conf.json").read_text())
base_spec = apple / "project.yml"
base_text = base_spec.read_text()
base_text = re.sub(r'(      - path: Externals\n)(?!        excludes:)', r'\1        excludes: ["**/*.a"]\n', base_text)
base_spec.write_text(base_text)
spec = {
    "include": ["project.yml", {"path": "../../native/project.yml", "relativePaths": False}],
    "targets": {"GroveActivity": {
        "settings": {"base": {"PRODUCT_BUNDLE_IDENTIFIER": config["identifier"] + ".activity"}},
        "info": {"properties": {"CFBundleShortVersionString": config["version"], "CFBundleVersion": config["version"]}},
    }},
}
if team:
    spec["settings"] = {"base": {"DEVELOPMENT_TEAM": team[1], "CODE_SIGN_STYLE": "Automatic"}}
(apple / "grove-native.json").write_text(json.dumps(spec))
subprocess.run(["xcodegen", "generate", "--spec", "grove-native.json"], cwd=apple, check=True)
text = project.read_text()
count = 0


def patch(match):
    global count
    script = json.loads(match[1])
    if "tauri ios xcode-script" not in script:
        return match[0]
    script = re.sub(r'^export PATH=.*\n', '', script).lstrip()
    count += 1
    return "shellScript = " + json.dumps(prefix + script) + ";"


updated = re.sub(r'shellScript = ("(?:\\.|[^"\\])*");', patch, text)
if count != 1:
    raise SystemExit(f"Expected one Tauri Rust build phase, found {count}")
if updated != text:
    project.write_text(updated)
print("Xcode Rust build phase tool paths configured.")
