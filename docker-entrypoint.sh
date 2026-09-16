#!/bin/sh
# Start myc in /workspace.
#
# A mounted project is used exactly as it is: myc finds its .myc/ workspace and
# serves the tools of that project. It is never initialised here — creating a
# workspace inside someone else's directory is not this image's business, and
# outside a workspace myc answers honestly with no tools at all.
#
# An EMPTY /workspace is the registry case: a probe (Glama, Docker MCP Toolkit)
# builds the image and lists the tools, so there has to be a workspace to serve.
# Emptiness is the only safe test: in a git worktree .git is a file pointing at
# a main tree that is not mounted, so neither `-d .git` nor `git rev-parse`
# recognises the directory as someone's project.
set -e
if [ -z "$(ls -A . 2>/dev/null)" ]; then
  git init -q
  git config user.email "mcp@example.invalid"
  git config user.name "mcp"
  myc init >&2
fi
exec myc "$@"
