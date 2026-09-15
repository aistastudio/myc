# myc as an MCP server in a container.
#
# myc is a local task-and-memory layer for coding agents; its MCP server
# answers from the workspace it is started in. This image installs the
# published npm package on Bun (myc binds to bun:sqlite and will not run on
# Node) and starts the server over stdio in /workspace. Mount a project there
# to use it for real; an empty /workspace is initialised on first start, so
# registries that build and probe servers themselves (Glama, Docker MCP
# Toolkit) get a server that starts and lists its tools:
#
#   docker build -t myc .
#   docker run -i --rm -v "$PWD:/workspace" myc

FROM oven/bun:1.3

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:$PATH

ARG MYC_VERSION=latest
RUN bun install -g @aistastudio/myc@${MYC_VERSION} && myc --version

WORKDIR /workspace
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["mcp", "--profile", "agent"]
