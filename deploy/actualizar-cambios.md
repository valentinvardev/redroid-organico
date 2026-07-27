# Actualizar cambios en el VPS

Referencia rápida para aplicar cambios y volver a probar el sistema.

**La clave de este stack: no hay paso de build.** El worker corre bajo `tsx`
(`npm run worker`) y la web bajo `next dev` (`npm run dev`), y los dos transpilan
TypeScript al vuelo. Así que "actualizar" casi siempre es solo **reiniciar el
servicio** que usa el archivo que tocaste.

Los servicios systemd son `redroid-worker` (el worker de publicación) y
`redroid-web` (el dashboard). Ver [redroid-worker.service](redroid-worker.service)
y [redroid-web.service](redroid-web.service).

## Según qué tocaste

| Cambiaste… | Qué ejecutás |
|---|---|
| `worker/`, `lib/` (incluye `lib/android/`, `lib/publisher/`) | `sudo systemctl restart redroid-worker` |
| `app/`, componentes, dashboard | `sudo systemctl restart redroid-web` (`next dev` suele recargar solo) |
| algo en `lib/` que usan los dos | `sudo systemctl restart redroid-worker redroid-web` |
| `package.json` (dependencias) | `npm ci`, después el restart |
| `prisma/schema.prisma` | `npx prisma migrate deploy && npx prisma generate`, después restart de ambos |
| `Dockerfile.appium` / `.ws-scrcpy` / `docker-compose.yml` | `docker compose --profile android up -d --build` |
| `scripts/*.ts` | nada — volvés a correr el script y listo |

La mayoría de los cambios de lógica caen en la primera fila → **solo
`restart redroid-worker`**.

Regla mental corta: **cambio de TypeScript = restart del servicio que lo usa;
cambio de dependencias / schema / Docker = un paso extra antes del restart.**

## Después de un `git pull` (cuando vino de todo junto)

Cubre el caso completo, sin tener que adivinar qué cambió:

```bash
cd ~/redroid-organico
git pull
npm ci                       # si cambió package-lock
npx prisma migrate deploy    # si hay migraciones nuevas
npx prisma generate          # si cambió el schema
sudo systemctl restart redroid-worker redroid-web
```

`npm ci` y los comandos de prisma son idempotentes: si no cambió nada, no hacen
nada. Correrlos de más no rompe.

## Verificar que levantó y ver errores

```bash
systemctl status redroid-worker --no-pager
journalctl -u redroid-worker -f        # logs en vivo; Ctrl-C para salir
```

El mensaje genérico del dashboard ("The phone could not be started…") nunca dice
el motivo real: ese está en el log del worker o en el del job.

## Probar de nuevo

- **Onboarding / link account** → desde el dashboard.
- **Egress del dispositivo** → `npm run device:egress -- --account <id>`
  (`--hold` deja el device arriba para chequear a mano por el visor).
- **Publicar / flows** → encolás con `scripts/bulkEnqueue.ts`
  (`--flow upload|login|scroll`, `--regions <labels>`).
- **Último job con su estado, error y logs** → `./node_modules/.bin/tsx scripts/lastJob.ts`.

> Usá `npm run <script>` o `./node_modules/.bin/tsx` para los scripts, no
> `npx tsx`: el `tsx` de la caché de `npx` no resuelve `dotenv` y falla al leer
> el `.env`.
