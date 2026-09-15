#!/bin/sh
# Start myc in /workspace. A mounted project with its own .myc/ is used as is;
# an empty directory becomes a fresh workspace so the MCP server has tools to list.
set -e
if [ ! -d .git ]; then
  git init -q
  git config user.email "mcp@example.invalid"
  git config user.name "mcp"
fi
if [ ! -d .myc ]; then
  myc init >&2
fi
exec myc "$@"
