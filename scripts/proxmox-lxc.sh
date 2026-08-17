#!/usr/bin/env bash

COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-${OMNISIGHT_SCRIPTS_URL:-https://raw.githubusercontent.com/caglaryalcin/OmniSight/main/deploy/community-scripts}}"
export COMMUNITY_SCRIPTS_URL

omnisight_ct_script="$(curl -fsSL "${COMMUNITY_SCRIPTS_URL}/ct/omnisight.sh")" || {
  echo "Failed to download the OmniSight Community Scripts entry point." >&2
  exit 115
}

exec bash -c "$omnisight_ct_script"
