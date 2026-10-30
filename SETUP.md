# SETUP — запуск, Supabase, публикация

Одно приложение обслуживает много студий: одна сборка, один проект Supabase, `tenant_id` везде.
Адреса: клиентам `/s/{slug}/`, владельцу `/s/{slug}/owner/`.

> **Что проверено, а что нет — смотрите в `ACCEPTANCE.md`.** Облачные шаги ниже (проект Supabase, секреты,
> Cron, деплой) написаны по документации и **не выполнялись из этой среды**.

## 0. Требования

- Node.js 22+, pnpm 10+ (`corepack enable`).
- Для облака: аккаунт Supabase и хостинг статики (Vercel или Cloudflare Pages).
- Для локальных проверок без Supabase CLI: PostgreSQL 16+ с расширениями `btree_gist`, `pgcrypto`
  (см. «Локальный запуск без Supabase»).

```bash
pnpm install
cp .env.example .env.local      # заполните значения ниже; сам файл в git не попадает
```

## 1. Локальный запуск

### 1а. Со Supabase CLI (рекомендуется, если есть Docker)

```bash
supabase start                 # поднимает Postgres, Auth, Storage, Edge Runtime
supabase db reset              # применяет supabase/migrations/* и supabase/seed.sql (две демо-студии)
# значения API URL и anon key печатает `supabase status`:
echo 'VITE_SUPABASE_URL=http://127.0.0.1:54321'  >> .env.local
echo 'VITE_SUPABASE_ANON_KEY=<anon key>'          >> .env.local
pnpm dev                       # http://localhost:5173/s/graphite/
```

Владелец демо-студии (локально):

```bash
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<service key> \
  OWNER_PASSWORD='придумайте-пароль' pnpm owner:create graphite   # почта берётся из tenants/graphite/business.json
```

Помощник (ИИ) локально: `supabase functions serve assistant --env-file .env.functions` (см. §4).

### 1б. Локальный запуск без Supabase CLI («стенд»)

Стенд поднимает **настоящий PostgreSQL** с настоящими миграциями и отдаёт собранное приложение, а запросы
`supabase-js` (`/rest/v1/rpc/*`, таблицы, вход, хранилище, помощник) обслуживает небольшой сервер из
`tests/harness`. Это **тестовая подмена Supabase API, а не Supabase**: GoTrue, PostgREST и Storage в нём не работают.
В помощнике стенда вместо LLM — набор правил по ключевым словам.

```bash
# нужен PostgreSQL; по умолчанию postgres://postgres@localhost:54329/postgres (переменная TEST_PG_URL)
pnpm harness                   # соберёт приложение и покажет адрес и данные входа владельца
```

## 2. Проект Supabase (облако)

```bash
supabase login
supabase link --project-ref <ref>
supabase db push                          # все миграции из supabase/migrations
psql "$DATABASE_URL" -f supabase/seed.sql # необязательно: две демо-студии в статусе «образец»
```

Миграции сами создают: таблицы, EXCLUDE-ограничение занятости (`btree_gist`), RLS и строгие GRANT,
бакет `tenant-media` (публичное чтение, запись только владельцам студии) и ежедневную очистку (`pg_cron`, если расширение включено).

**Настройки Auth в панели Supabase (обязательно):**

1. Authentication → Sign In / Providers → **выключить «Allow new users to sign up»**. Публичной регистрации владельцев нет;
   пользователей создаёт `pnpm owner:create` через admin API.
2. Email-провайдер включён, подтверждение почты для созданных админом пользователей не требуется.

Секреты Edge Functions (`supabase secrets set …`, **не** в репозиторий и **не** во фронтенд):

| Секрет | Зачем |
| --- | --- |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | любой OpenAI-совместимый провайдер для помощника |
| `LLM_TOOL_MODE=json` | необязательно: для моделей без вызова инструментов (режим JSON-намерений) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push (`npx web-push generate-vapid-keys`; subject — `mailto:вы@пример.рф`) |
| `DISPATCH_SECRET` | общий секрет, которым Cron вызывает `push-dispatch` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` Edge Functions получают от платформы сами.

```bash
supabase secrets set LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... \
  VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com DISPATCH_SECRET=$(openssl rand -hex 24)
supabase functions deploy assistant
supabase functions deploy push-dispatch
```

Публичный VAPID-ключ нужен ещё и сборке: `VITE_VAPID_PUBLIC_KEY=<то же значение>`.

## 3. Cron для напоминаний (раз в минуту)

Нужны расширения `pg_cron`, `pg_net` и Vault (Database → Extensions). Один раз, в SQL Editor:

```sql
select vault.create_secret('<DISPATCH_SECRET>', 'dispatch_secret');

select cron.schedule(
  'avto-push-dispatch', '* * * * *',
  $$ select net.http_post(
       url     := 'https://<ref>.supabase.co/functions/v1/push-dispatch',
       headers := jsonb_build_object(
                    'content-type', 'application/json',
                    'x-dispatch-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_secret')),
       body    := '{}'::jsonb) $$);
```

Как это устроено: клиент включает напоминание → в `notification_jobs` создаётся одна задача (дедупликация
`<booking_id>:reminder_24h`) на «время записи − 24 ч»; диспетчер забирает пачку с арендой (`SKIP LOCKED`), шлёт push,
при сбое повторяет с задержкой (не более 5 попыток), мёртвые подписки (404/410) удаляет; при отмене записи задача
отменяется, при переносе пересчитывается. Образцы студий и неактивные записи не уведомляются.

## 4. Помощник (ИИ)

Функция `assistant` принимает `{slug, mode: 'client'|'owner', messages}`.

- **Клиентский режим**: услуги, цены, график, свободное время. Только публичные данные.
- **Владельческий режим**: ещё статистика и записи (без телефонов клиентов). Все запросы к данным идут **с JWT владельца**,
  поэтому решает база (RLS и проверка членства), а не функция. **Помощник ничего не меняет.**
- Модель не выбирает ни студию, ни SQL: студия берётся из запроса, инструменты принимают только строго проверенные аргументы.
- Цикл инструментов ограничен 4 шагами; без вызова инструментов у провайдера работает запасной режим JSON-намерений.
- Лимиты — в общих атомарных счётчиках базы: запросы в окне (`rate_hit`) и дневной бюджет вызовов/токенов на студию (`llm_reserve`).
- Если помощник недоступен, запись работает как обычно: он нигде не стоит на пути бронирования.

## 5. Студии: конвейер

См. также `CLONE-IN-6-MINUTES.md`.

```bash
pnpm tenant:new my-studio --name "Моя студия" --accent "#E5533D"   # создаёт tenants/my-studio/
pnpm tenant:validate my-studio          # схема, файлы и размеры фото, контраст акцента на чёрном
DATABASE_URL=... pnpm tenant:publish my-studio   # изображения + запись в БД в одной транзакции
pnpm build                              # оболочка, manifest, иконки и worker каждой студии
DATABASE_URL=... pnpm tenant:verify my-studio --dist dist [--url https://...] --activate
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm owner:create my-studio
```

- `business.json` и фото — **вход конвейера**; во время работы источником истины служит база.
- Повторная публикация **не трогает**: записи, оплаты, токены, фото, загруженные владельцем, статус `live`.
  Услуги и боксы, убранные из файла, **отключаются** (не удаляются); фото «из файла», убранные из файла, удаляются.
  Поля, которыми управляет файл (название, описание, цены, график), при публикации перезаписываются —
  правки владельца в этих полях сбросятся. Это сказано владельцу в «Настройки».
- Новая студия создаётся в статусе **образец**: на ней видна пометка «Образец студии», настоящие уведомления не отправляются.
  Боевой режим включает только `tenant:verify --activate` после успешной проверки.
- Демо-данные студий лежат в `supabase/seed.sql` (генерируется `pnpm tenant:seed`) и помечены `is_demo`.

## 6. Публикация

Фронтенд — статика (`dist/`). `pnpm build` = `vite build` + `scripts/tenants/build-pwa.ts`: для каждой студии создаёт
`dist/s/<slug>/{index.html, manifest.webmanifest, sw.js, icons/*, media/*}`.

**Vercel**: репозиторий → Import; `vercel.json` уже задаёт сборку, правило глубоких ссылок и заголовки.
Переменные окружения проекта: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY`.

**Cloudflare Pages**: команда сборки `pnpm build`, каталог `dist`; `dist/_redirects` и `dist/_headers` создаются сборкой.

Сборка читает папку `tenants/` целиком: **студия попадает на сайт, когда её папка есть в репозитории**.
Поэтому добавили студию — закоммитьте папку и пересоберите.

Глубокие ссылки (`/s/<slug>/my`, `/s/<slug>/owner/`) отвечают оболочкой именно этой студии (правило
`/s/:slug/* → /s/:slug/index.html`; настоящие файлы всегда приоритетнее правила).

Проверка после публикации: `pnpm tenant:verify <slug> --dist dist --url https://ваш-адрес --activate`.

## 7. Команды

| Команда | Что делает |
| --- | --- |
| `pnpm dev` | разработка (нужны `VITE_SUPABASE_*`) |
| `pnpm build` | production-сборка со всеми студиями |
| `pnpm typecheck` | `tsc --noEmit`, strict |
| `pnpm test` | Vitest: SQL/интеграция на реальном PostgreSQL, ядро ИИ, диспетчер, гигиена репозитория |
| `pnpm e2e` | Playwright на стенде (`tests/harness`) |
| `pnpm harness` | стенд для ручного просмотра |
| `pnpm tenant:*`, `pnpm owner:create` | конвейер студий |

Для `pnpm test` и `pnpm e2e` нужен PostgreSQL (`TEST_PG_URL`, по умолчанию `postgres://postgres@localhost:54329/postgres`, роль с правом `CREATE DATABASE`).
Если Playwright не находит свой Chromium, укажите `PW_CHROMIUM=/путь/к/chrome`.
