# myc server (M4) — образ для развёртывания на сервере команды.
#
# ЧТО ВНУТРИ И ПОЧЕМУ ИМЕННО ЭТО. Один самодостаточный бинарь `myc`, собранный
# `bun build --compile`: в нём и сервер, и админка, и СХЕМА Postgres (вшита
# текстовым импортом), поэтому образу не нужны ни psql, ни исходники, ни
# каталог с файлами рядом. Разворачивают одну вещь — это и есть «быстро».
#
# ОБРАЗ НЕ ЗНАЕТ ПАРОЛЕЙ. Строка подключения приходит переменной MYC_PG_URL, а
# токены доступа живут в базе, а не в образе: собранный образ можно катить
# куда угодно, он одинаков для всех.
#
# TLS ЗДЕСЬ НЕТ НАМЕРЕННО. Сервер слушает HTTP на 0.0.0.0 внутри контейнера и
# стоит за обратным прокси (Caddy, nginx, traefik), который и держит
# сертификат. Прокси обязан ставить X-Forwarded-Proto: по нему сервер решает,
# выдавать ли куку сессии с флагом Secure.
#
# Сборка и запуск:
#   docker build -f deploy/server.Dockerfile -t myc-server .
#   docker run --rm -e MYC_PG_URL=postgres://myc_app:…@db:5432/myc -p 8080:8080 myc-server
# Первый запуск на пустой базе (схему накатывает СУПЕРПОЛЬЗОВАТЕЛЬ: она создаёт
# таблицы, триггеры и политики RLS, и прав myc_app на это нет; роль myc_app со
# входом заводит развёртывание — см. deploy/initdb/10-app-role.sql):
#   docker run --rm -e MYC_PG_URL=postgres://postgres:…@db:5432/myc myc-server serve --apply-schema
#   docker run --rm -e MYC_PG_URL=postgres://myc_app:…@db:5432/myc myc-server serve --add-tenant acme
#   docker run --rm -e MYC_PG_URL=postgres://myc_app:…@db:5432/myc myc-server serve --add-token acme:anna

# --- сборка ------------------------------------------------------------------
FROM oven/bun:1.3 AS build
WORKDIR /src

# Зависимости отдельным слоем: они меняются реже исходников, и пересборка
# после правки кода не тянет установку заново.
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile

COPY db ./db
COPY scripts ./scripts
COPY bunfig.toml ./
RUN bun run build

# --- образ -------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# ca-certificates — не для myc (он в сеть не ходит), а для TLS до Postgres,
# когда база в управляемом облаке и требует проверяемый сертификат.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Непривилегированный пользователь: сервер ничего не пишет на диск — ни базы,
# ни кеша, — поэтому и права ему не нужны.
RUN useradd --system --create-home --uid 10001 myc
COPY --from=build /src/dist/myc /usr/local/bin/myc
USER myc
WORKDIR /home/myc

ENV MYC_SERVE_PORT=8080
EXPOSE 8080

# Проба живости — единственный открытый маршрут (всё остальное требует токен),
# и она ничего не знает о базе: контейнер жив, даже когда Postgres лёг, и
# оркестратор не должен перезапускать его из-за чужой аварии.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/myc", "serve", "--health-probe"]

ENTRYPOINT ["/usr/local/bin/myc"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8080"]
