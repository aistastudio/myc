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

# The global install goes to a shared prefix, not to /root: the container runs
# as a non-root user (below), and that user has to reach the binary.
ENV BUN_INSTALL=/usr/local
ENV PATH=/usr/local/bin:$PATH

# Pinned: the same Dockerfile built twice must give the same myc. Raise it with
# --build-arg MYC_VERSION=<version>.
ARG MYC_VERSION=0.3.14
RUN bun install -g @aistastudio/myc@${MYC_VERSION} && myc --version

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /workspace && chown bun:bun /workspace

# Not root: a mounted project gets its .myc/ and episode files owned by the
# user who ran the container, not by root. Pass --user "$(id -u):$(id -g)" to
# match your own uid on a Linux host.
WORKDIR /workspace
USER bun

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["mcp", "--profile", "agent"]
