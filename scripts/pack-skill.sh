#!/usr/bin/env bash
# zips skill/ for Chord's "create a teammate" upload. files sit at the zip root.
set -euo pipefail
cd "$(dirname "$0")/../skill"
mkdir -p ../dist
rm -f ../dist/asa-thrift-skill.zip
zip -qr ../dist/asa-thrift-skill.zip SKILL.md references -x '.*'
unzip -l ../dist/asa-thrift-skill.zip
