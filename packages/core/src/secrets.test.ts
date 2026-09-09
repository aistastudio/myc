import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./secrets.ts";

// Синтетические строки корректной формы. НИ ОДНОГО настоящего секрета.

/**
 * Slack-образцы собираются из кусков, а не лежат литералом.
 *
 * Значения выдуманные — канонические плейсхолдеры из документации Slack
 * (`T00000000/B00000000/XXXX…`) и последовательности вида `abcdefgh`. Но
 * push protection на GitHub смотрит на ФОРМУ, а не на смысл, и отклоняет пуш
 * целиком: «Push cannot contain secrets». Разрешить исключение по ссылке
 * можно, но это приучает нажимать «всё равно запушить» — а однажды там будет
 * настоящий ключ.
 *
 * Маскировщик получает ровно ту же строку: склейка происходит до вызова.
 */
const slackBotToken = ["xoxb", "1234567890-1234567890123-fakefaketokenvalue"].join("-");
const slackWebhook = ["https://hooks.slack.com/services", "T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"].join("/");

const POSITIVE_CASES: ReadonlyArray<{ readonly label: string; readonly text: string }> = [
  { label: "aws_access_key_id", text: "AWS_ACCESS_KEY_ID=A" + "KIAIOSFODNN7EXAMPLE" },
  {
    label: "aws_secret_access_key",
    text: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
  },
  { label: "gcp_api_key", text: "GOOGLE_API_KEY=AIzaSyD-FAK" + "E1234567890abcdefGHIJKLmnop" },
  { label: "google_oauth_client_secret", text: "client_secret: GOCSPX-" + "fakefakefakefakeFAKE123" },
  {
    label: "openai_project_key",
    text: "OPENAI_API_KEY=sk-proj-abcdefgh" + "ijklmnopqrstuvwxyzABCDEFGHIJKLMN",
  },
  { label: "openai_key", text: "OPENAI_API_KEY=sk-abcdefg" + "hijklmnopqrstuvwxyzABCDEF" },
  { label: "anthropic_key", text: "ANTHROPIC_API_KEY=sk-ant-api03" + "-fake1234567890ABCDEFghijklmnop" },
  { label: "slack_bot_token", text: `SLACK_TOKEN=${slackBotToken}` },
  {
    label: "slack_webhook",
    text: `webhook: ${slackWebhook}`,
  },
  { label: "github_pat_classic", text: "GITHUB_TOKEN=ghp_123456789" + "0abcdefghijklmnopqrstuvwxyz" },
  {
    label: "github_pat_fine_grained",
    text: "GH_TOKEN=github_pat_11AAAAAAA0abcdefg" + "hijklmnopqrstuvwxyz1234567890ABCDEFGHI",
  },
  { label: "stripe_secret_key", text: "STRIPE_KEY=sk_live_FAKE1" + "234567890abcdefghijklmno" },
  { label: "npm_token", text: "//registry.npmjs.org/:_authToken=npm" + "_ABCDEFghijklmnopqrstuvwxyz0123456789" },
  {
    label: "sendgrid_key",
    text: "SENDGRID_API_KEY=SG.fakeFakeFakeFake1" + "23.anotherFakeSegmentHere4567890abcdef",
  },
  { label: "mailgun_key", text: "MAILGUN_API_KEY=key-012345" + "6789abcdef0123456789abcdef" },
  {
    label: "digitalocean_token",
    text:
      "DO_TOKEN=dop_v1_" +
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
  },
  {
    label: "azure_storage_connection_string",
    text:
      "AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=fakeacct;" +
      "AccountKey=FAKEabcdEFGHijklMNOPqrstUVWXyz0123456789+/==;EndpointSuffix=core.windows.net",
  },
  {
    label: "private_key_pem_rsa",
    text:
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIEpAIBAAKCAQEAfakefakefakefakefakefakefakefakefakefakefakefake\n" +
      "-----END RSA PRIVATE KEY-----",
  },
  {
    label: "private_key_pem_openssh",
    text:
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAFwfake\n" +
      "-----END OPENSSH PRIVATE KEY-----",
  },
  {
    label: "jwt",
    text:
      "Authorization token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  },
  {
    label: "db_connection_string_postgres",
    text: "DATABASE_URL=postgresql://appuser:S3cretPassw0rd!@db.internal.example.com:5432/prod",
  },
  {
    label: "db_connection_string_mongodb",
    text: "MONGO_URL=mongodb+srv://svc:FakeP4ssw0rd@cluster0.example.mongodb.net/mydb",
  },
  {
    label: "basic_auth_url",
    text: "curl https://deployer:hunter2fakepass@ci.example.com/api/trigger",
  },
  {
    label: "authorization_header_bearer",
    text: "Authorization: Bearer fakeFAK" + "Etoken1234567890abcdefGHIJKLMN",
  },
  { label: "twilio_api_key_sid", text: "TWILIO_API_KEY=SK0123456" + "789abcdef0123456789abcdef" },
  { label: "generic_password_assignment", text: "DB_PASSWORD=Sup3r" + "S3cretFakeValue!!" },
  { label: "generic_secret_assignment", text: "APP_SECRET=fake01234" + "56789ABCDEFghijklmnop" },
  { label: "generic_token_assignment", text: "SESSION_TOKEN=abcFAKE0" + "123456789TOKENvalueHere" },
  {
    label: "high_entropy_generic_api_key",
    text: 'api_key: "qX7mZ2vR9tKp4nL6wY1jH8sD3fB0gC5eA9uT2rM7kN4vP"',
  },
  {
    label: "high_entropy_secret_field",
    text: "config.secret = 'zQ8pL3vN6xR1tK" + "9mW4jH7yB2fC5dG0eS9aU3rT6kM1vP'",
  },
  {
    label: "high_entropy_credential_field",
    text: 'credential = "mF9xK2pQ7vL4tR1jN8wY6zC3bH5dG0eS9aU2rT7kM4vX"',
  },
];

const BENIGN_CASES: ReadonlyArray<{ readonly label: string; readonly text: string }> = [
  { label: "git_commit_hash_sha1", text: "commit: 4f6a1c2e9b3d7f0a" + "1c5e8b2d6f9a3c7e1b5d9f2a" },
  {
    label: "sha256_checksum",
    text: "sha256sum: e3b0c44298fc1c149afbf4c89" + "96fb92427ae41e4649b934ca495991b7852b8",
  },
  { label: "md5_hash", text: "md5: d41d8cd98f00b" + "204e9800998ecf8427e" },
  { label: "uuid_v4", text: "request_id: 550e8400-e29" + "b-41d4-a716-446655440000" },
  {
    label: "base64_png_data_url",
    text:
      'img.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="',
  },
  {
    label: "base64_jpeg_data_url_long",
    text:
      "background: url(data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRETDQ4PEBAREAoMEhMSEBMPEBAQ)",
  },
  {
    label: "minified_js_bundle",
    text:
      "!function(e,t){var n=e.foo||{};n.bar=function(a,b,c,d){return a+b*c-d}," +
      "n.baz=function(x){return x.map(function(y){return y*2})}}(window,document);",
  },
  {
    label: "long_file_path",
    text: "/Users/alice/src/project/packages/core/src/very/deeply/nested/directory/structure/file.ts",
  },
  {
    label: "long_url_no_creds",
    text: "see https://example.com/docs/api/v3/referen" + "ce/very-long-descriptive-slug-for-this-page",
  },
  {
    label: "css_hex_colors",
    text: ".btn { color: #a1b2c3; background: #001122; border: 1px solid #ffeeaa; }",
  },
  {
    label: "lorem_ipsum_prose",
    text:
      "Настоящая проза без секретов: этот абзац описывает архитектуру модуля " +
      "и не содержит присваиваний ключей, паролей или токенов вообще.",
  },
  {
    label: "package_lock_integrity",
    text:
      '"integrity": "sha512-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=="',
  },
  {
    label: "code_variable_names",
    text: "const veryLongDescriptiveVariableNameForSome" + "thingImportantInTheCodebase = computeValue();",
  },
  {
    label: "regular_env_var_short",
    text: "NODE_ENV=production\nPORT=8080\nLOG_LEVEL=debug",
  },
  {
    label: "commit_sha_in_sentence",
    text: "Пофикшено в коммите 9c8f3e2a1b" + "0d7c6e5f4a3b2c1d0e9f8a7b6c5d4e.",
  },
];

describe("redactSecrets — паттерны + энтропия ловят реальные секреты", () => {
  for (const { label, text } of POSITIVE_CASES) {
    test(label, () => {
      const result = redactSecrets(text);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.text).not.toBe(text);
    });
  }

  test("доля пойманных секретов и итоговый отчёт", () => {
    let caught = 0;
    for (const { text } of POSITIVE_CASES) {
      if (redactSecrets(text).findings.length > 0) caught += 1;
    }
    const rate = caught / POSITIVE_CASES.length;
    // eslint-disable-next-line no-console
    console.log(
      `[secrets] поймано ${caught}/${POSITIVE_CASES.length} видов секретов (${(rate * 100).toFixed(1)}%)`,
    );
    expect(rate).toBeGreaterThanOrEqual(0.9);
  });
});

describe("redactSecrets — безобидный текст не маскируется (ложные срабатывания)", () => {
  test("доля ложных срабатываний на безобидном наборе", () => {
    let falsePositives = 0;
    const offenders: string[] = [];
    for (const { label, text } of BENIGN_CASES) {
      const result = redactSecrets(text);
      if (result.findings.length > 0) {
        falsePositives += 1;
        offenders.push(label);
      }
    }
    const rate = falsePositives / BENIGN_CASES.length;
    // eslint-disable-next-line no-console
    console.log(
      `[secrets] ложных срабатываний ${falsePositives}/${BENIGN_CASES.length} (${(rate * 100).toFixed(1)}%)` +
        (offenders.length > 0 ? ` — ${offenders.join(", ")}` : ""),
    );
    expect(rate).toBeLessThanOrEqual(0.1);
  });
});

describe("redactSecrets — маскирование", () => {
  test("плейсхолдер сохраняет тип и заменяет только значение, текст вокруг цел", () => {
    const text = "before DB_PASSWORD=Sup3rS3cretFakeValue!! after";
    const result = redactSecrets(text);
    expect(result.text.startsWith("before DB_PASSWORD=<redacted:")).toBe(true);
    expect(result.text.endsWith(" after")).toBe(true);
    expect(result.text).toContain("<redacted:generic_key_assignment:");
  });

  test("одинаковый секрет даёт одинаковый плейсхолдер в разных местах текста", () => {
    const secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const text = `first: ${secret}\nsecond: ${secret}`;
    const result = redactSecrets(text);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.placeholder).toBe(result.findings[1]?.placeholder);
  });

  test("разные секреты одного типа дают разные плейсхолдеры", () => {
    const a = "AKIAIOSFODNN7EXAMPLA";
    const b = "AKIAIOSFODNN7EXAMPLB";
    const result = redactSecrets(`${a}\n${b}`);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.placeholder).not.toBe(result.findings[1]?.placeholder);
  });

  test("находки отдают тип, диапазон и уверенность — не тихая правка", () => {
    const text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const result = redactSecrets(text);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding?.kind).toBe("aws_access_key_id");
    expect(finding?.confidence).toBe("high");
    expect(typeof finding?.start).toBe("number");
    expect(typeof finding?.end).toBe("number");
    expect(text.slice(finding!.start, finding!.end)).toBe("AKIAIOSFODNN7EXAMPLE");
  });

  test("текст без секретов возвращается без изменений и без находок", () => {
    const text = "просто текст заметки без секретов вообще";
    const result = redactSecrets(text);
    expect(result.text).toBe(text);
    expect(result.findings).toHaveLength(0);
  });
});

/**
 * Написание секрета в реальном коде и выводе — не одно, а десяток, и правило
 * ловило только одно из них. Сообщено с живого проекта: `DB_PASSWORD=…`
 * маскировался, а `db_password=…`, `password=…`, `api_key=…` и `PGPASSWORD=…`
 * уходили в эпизод сжатия ОТКРЫТЫМ ТЕКСТОМ. Память, которая пишется
 * автоматически и живёт годами, — худшее место для незамаскированного пароля.
 *
 * Проверяются обе границы сразу, потому что они тянут в разные стороны:
 * ослабишь — «monkey=» и «turkeys=» станут секретами и проза превратится в
 * решето; ужесточишь — вернётся утечка.
 */
describe("redactSecrets — написание секрета не спасает его от маскировки", () => {
  const МАСКИРУЕТСЯ = [
    "DB_PASSWORD=hunter2long",
    "db_password=hunter2long",
    "password=hunter2long",
    "passwords=abcdefgh12345",
    "DB_Password=hunter2long",
    "API_KEY=abcdefgh12345",
    "api_key=abcdefgh12345",
    "my.api.key=abcdefgh12345",
    "PGPASSWORD=hunter2long",
    "MYSQLPWD=abcdefgh12345",
    "secret: abcdefgh12345",
  ];
  const НЕ_МАСКИРУЕТСЯ = [
    "ключ: да",
    "monkey=abcdefgh12345",
    "donkey: abcdefgh12345",
    "turkeys=abcdefgh12345",
    "hockeys=abcdefgh12345",
  ];

  for (const line of МАСКИРУЕТСЯ) {
    test(`скрыт: ${line}`, () => {
      const r = redactSecrets(line);
      expect(r.text).not.toBe(line);
      expect(r.text).toContain("<redacted:");
      // Само значение не должно уцелеть ни в каком виде.
      expect(r.text).not.toContain(line.split(/[:=]/).slice(1).join("").trim());
    });
  }

  for (const line of НЕ_МАСКИРУЕТСЯ) {
    test(`не тронут: ${line}`, () => {
      expect(redactSecrets(line).text).toBe(line);
    });
  }
});

describe("redactSecrets — бюджет времени", () => {
  test("укладывается в 5 мс на транскрипте ~100 КБ", () => {
    const chunk =
      "Обычная строка транскрипта сессии агента без секретов, просто разговор о коде.\n";
    const secretLines = [
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN\n",
      "Authorization: Bearer fakeFAKEtoken1234567890abcdefGHIJKLMN\n",
      'commit: 4f6a1c2e9b3d7f0a1c5e8b2d6f9a3c7e1b5d9f2a\n',
    ];
    let text = "";
    let i = 0;
    while (text.length < 100_000) {
      text += i % 7 === 0 ? secretLines[i % secretLines.length] : chunk;
      i += 1;
    }

    // прогрев (JIT), не учитываем в замере
    redactSecrets(text);
    redactSecrets(text);

    const runs = 20;
    const start = performance.now();
    for (let r = 0; r < runs; r++) {
      redactSecrets(text);
    }
    const elapsedMs = (performance.now() - start) / runs;

    // eslint-disable-next-line no-console
    console.log(
      `[secrets] ${(text.length / 1024).toFixed(1)} КБ, среднее время redactSecrets: ${elapsedMs.toFixed(3)} мс (бюджет 5 мс)`,
    );
    // Абсолютный бюджет проверяется только там, где он откалиброван: числа
    // сняты на рабочей машине, а на загруженной тот же код честно медленнее —
    // тест падал под параллельным прогоном, сообщая о машине вместо кода.
    // Правило повторено, а не импортировано: `core` по архитектуре не зависит
    // ни от чего, включая `@myc/bench` (см. scripts/deps-check.ts).
    //
    // Цена ВЫРОСЛА и это осознанно: второе правило для слитных имён
    // (`PGPASSWORD`) удвоило проход — замер 0.434 -> 0.940 мс на 97 КБ прозы.
    // Запас к бюджету остаётся пятикратным, а без второго правила пароль
    // уходил в память открытым текстом.
    const calibrated =
      process.env["MYC_BENCH_ABSOLUTE"] !== "0" || process.env["MYC_BENCH_STRICT"] === "1";
    if (elapsedMs >= 5 && !calibrated) {
      // eslint-disable-next-line no-console
      console.log(`[secrets] бюджет 5 мс НЕ ПРОВЕРЯЕТСЯ: машина не откалибрована`);
    } else {
      expect(elapsedMs).toBeLessThan(5);
    }
  });
});
