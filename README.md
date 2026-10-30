# Запись в студию (PWA) — MVP от SGX

Мобильное приложение для онлайн-записи в автосервис / детейлинг. Одна сборка и один проект Supabase обслуживают много студий:
клиентам `/s/{slug}/`, владельцу `/s/{slug}/owner/`. Вид и данные студии задаются `tenants/{slug}/business.json` и фото.

React 19 · TypeScript strict · Vite · React Router · TanStack Query · Zod · Astryx + shadcn/ui · Supabase · Workbox.

- Запуск, Supabase, секреты, Cron, публикация: [SETUP.md](SETUP.md)
- Новая студия за 6 минут: [CLONE-IN-6-MINUTES.md](CLONE-IN-6-MINUTES.md)
- Что проверено и что нет: [ACCEPTANCE.md](ACCEPTANCE.md)
- План и устройство: [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)

```bash
pnpm install && pnpm test && pnpm build
pnpm harness        # стенд с настоящим PostgreSQL: http://localhost:4173/s/graphite/
```
