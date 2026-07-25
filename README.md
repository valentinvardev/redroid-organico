# redroid-organico

Cola de publicación asíncrona: Next.js + Prisma/PostgreSQL + BullMQ/Redis, con
pipeline de media, reintentos idempotentes, observabilidad por job y dashboard en
vivo.

## Estado

Implementado: las ocho fases M0–M7 del roadmap, autenticación con sesiones,
gestión de usuarios, rotación de claves de cifrado, y 79 tests (70 de integración
contra Postgres y Redis reales, 9 sin infraestructura).

**El sistema todavía no publica en ninguna plataforma.** La capa que entrega el
post es un adaptador enchufable y el único registrado es `stub`, que ejercita todo
el pipeline sin contactar nada externo. Ver [Publicación real](#publicación-real).

### Qué está verificado y qué no

Ejecutado y comprobado contra infraestructura real:

- Ciclo completo de publicación: upload → validación con ffprobe → thumbnail →
  encolado → worker → publicación (con el stub) → logs
- Idempotencia, reintentos con backoff, agotamiento hacia la DLQ, recuperación de
  huérfanos tras caída del worker, rate limit por cuenta
- Flujo de autenticación completo: 401 sin sesión, 429 al noveno login fallido,
  cambio de contraseña con invalidación de sesiones
- Rotación de claves con re-sellado

Escrito pero **sin ejecutar nunca**:

- **El `Dockerfile` y el `docker-compose.yml` completo.** El desarrollo usó solo
  el compose de datastores; la imagen de producción, el contenedor de migraciones
  y el healthcheck están sin construir.
- **El workflow de CI.** Existe el archivo, pero nunca corrió, así que no hay
  garantía de que `test:setup`, el ffmpeg de Ubuntu y los servicios se comporten
  como espera.
- **Despliegue y HTTPS.** Nunca se desplegó. La cookie se marca `secure` sola con
  `NODE_ENV=production`, pero eso requiere TLS delante.

## Requisitos

- Node.js 20+
- PostgreSQL 16+
- Redis 7+
- ffmpeg y ffprobe en el `PATH` (opcional: sin ellos los uploads se aceptan pero
  no se validan, y queda registrado en `validationErrors`)

## Puesta en marcha

```bash
npm ci

cp .env.example .env
# Generar la clave de cifrado de credenciales:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Pegarla en CREDENTIALS_KEY

# Levantar solo los datastores; la app corre en el host
docker compose -f docker-compose.dev.yml up -d

npx prisma migrate deploy

# Imprime una contraseña generada una sola vez; guardala.
# O fijala vos:  SEED_PASSWORD=... npm run db:seed
npm run db:seed

# En dos terminales
npm run dev
npm run worker
```

Dashboard en http://localhost:3000 (pide login), salud en
http://localhost:3000/api/health.

Sin Docker: alcanza con un PostgreSQL y un Redis accesibles y apuntar
`DATABASE_URL` y `REDIS_URL` a ellos.

> El compose publica Postgres en el puerto **5433** del host, no en 5432, para no
> chocar con una instalación nativa de PostgreSQL. Dentro de la red de compose los
> contenedores lo siguen viendo como `postgres:5432`.

### Todo en contenedores

```bash
docker compose up --build
```

Levanta Postgres, Redis, corre las migraciones y arranca web y worker. Web y
worker comparten el volumen `media` porque con `STORAGE_DRIVER=local` el worker
lee los archivos que escribió la web; con `s3` ese acoplamiento desaparece.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor Next.js en modo desarrollo |
| `npm run worker` | Worker de publicación (proceso separado) |
| `npm run worker:dev` | Worker con recarga en caliente |
| `npm run smoke` | Tests de cripto, validación y clasificación de errores (no requiere infra) |
| `npm test` | Smoke + integración |
| `npm run test:setup` | Crea `redroid_test` y le aplica las migraciones |
| `npm run test:integration` | Suite de integración contra Postgres y Redis |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:migrate` | Crear y aplicar una migración en desarrollo |
| `npm run db:deploy` | Aplicar migraciones pendientes (producción) |
| `npm run db:seed` | Usuario y cuenta de desarrollo |
| `npm run db:studio` | Prisma Studio |
| `npm run user:create` | Crear un usuario o resetear su contraseña |
| `npm run keys:rotate` | Re-sellar credenciales con la `CREDENTIALS_KEY` actual |

## Arquitectura

```
POST /api/videos ──► ingest: hash → dedupe → storage → ffprobe → validar → thumbnail
                                                                      │
POST /api/jobs ────► crear Job (idempotencyKey único) ──► BullMQ ◄─────┘
                                                            │
                                        worker/index.ts ────┤ concurrencia N
                                                            │
                              lib/worker/processJob.ts ─────┤ rate limit por cuenta
                                                            │ stage media a disco
                                                            │ descifrar credenciales
                                                            ▼
                                              lib/publisher/registry.ts
                                                            │
                                                    StubPublisher
```

### Dónde está cada cosa

| Ruta | Contenido |
| --- | --- |
| `app/api/` | Rutas HTTP: jobs, videos, accounts, auth, health, stream SSE |
| `app/components/` | Dashboard, formulario de composición, login |
| `lib/auth/` | Sesiones, scrypt, throttle de login, altas de usuarios |
| `lib/crypto/` | Cifrado AES-256-GCM de credenciales, con rotación |
| `lib/jobs/` | Creación, cancelación y reintento de jobs |
| `lib/media/` | Ingesta, validación contra specs, ffprobe, storage local/S3 |
| `lib/publisher/` | Contrato del adaptador, errores clasificados, stub |
| `lib/queue/` | Conexión a Redis, cola de publicación y dead-letter |
| `lib/worker/` | Procesador de jobs, rate limiter, creación del worker |
| `worker/index.ts` | Entrypoint del proceso worker |
| `prisma/` | Schema, migraciones, seed |
| `scripts/` | Smoke tests, alta de usuarios, rotación de claves, setup de test |
| `tests/` | Suite de integración y helpers |

### Puntos de diseño que importan

**Idempotencia.** `Job.idempotencyKey` tiene constraint único. El cliente manda
`Idempotency-Key`; un doble click, un reintento de red o dos requests
concurrentes resuelven al mismo job en vez de generar dos publicaciones. El
`jobId` de BullMQ es el id de la fila, así que un re-encolado accidental lo
descarta Redis. Y `processJob` verifica `COMPLETED` antes de publicar, por si la
cola entrega dos veces.

**Reintentos.** Backoff exponencial desde `RETRY_BACKOFF_MS` (por defecto 15s →
60s → 240s) sobre `RETRY_ATTEMPTS` intentos.
Los errores se clasifican en `lib/publisher/errors.ts`: un `PublishError` con
`retryable: false` corta los reintentos vía `UnrecoverableError` de BullMQ; un
error sin clasificar se asume transitorio. Agotados los intentos, el job pasa a
`DEAD` y se registra en la cola `publish-dead`, desde donde se puede reintentar
manualmente en el dashboard.

**Rate limit por cuenta.** Dos límites independientes en Redis, compartidos entre
réplicas del worker: `maxConcurrent` y `minIntervalSeconds`. Cuando frena un job,
este se posterga sin consumir un intento — throttling nunca agota el presupuesto
de reintentos.

**Recuperación.** Un worker que muere a mitad de un job dejaba la fila en
`PROCESSING` para siempre. Al arrancar, `recoverOrphans()` busca esas filas,
verifica contra BullMQ que nadie las esté procesando, y las re-encola. El
shutdown con SIGTERM espera a que terminen los jobs activos (`worker.close(false)`)
en vez de matarlos, porque un job de publicación interrumpido y re-entregado
puede significar un post duplicado.

**Credenciales.** `Account.credentials` se guarda cifrado con AES-256-GCM
(`lib/crypto/secretBox.ts`), se descifra solo dentro del worker y solo durante un
job. El `JobLogger` redacta por lista de claves, así que un `log.info` descuidado
no filtra un token.

## Publicación real

Todo lo de arriba es agnóstico a cómo llega el post a la plataforma. El contrato
está en `lib/publisher/types.ts` y el registro en `lib/publisher/registry.ts`.

El adaptador previsto es la **API oficial de publicación de contenido de TikTok**,
con tokens OAuth por cuenta guardados en `Account.credentials`. Implementar
`Publisher`, registrarlo y ampliar `PUBLISHER_DRIVER` en `lib/env.ts` es todo lo
que hace falta; nada aguas arriba cambia.

`PUBLISHER_DRIVER` solo acepta `stub` hoy, a propósito: nada puede correr en
producción creyendo que publicó algo cuando en realidad no contactó a nadie.

## Autenticación

Sesiones con cookie `httpOnly`, sin dependencias externas.

Las contraseñas se guardan con **scrypt** de la stdlib de Node
(`lib/auth/password.ts`), con los parámetros de costo embebidos en cada hash — así
subirlos más adelante no invalida las contraseñas existentes: se rehashean en el
siguiente login exitoso.

La cookie lleva un token aleatorio de 256 bits y la base guarda **solo su
SHA-256**, así que un dump de `sessions` no se puede reproducir como login. Las
sesiones cerca de vencer se renuevan al usarlas.

`/api/auth/login` cuenta los fallos por email y por IP en Redis y responde 429 al
noveno intento dentro de 15 minutos. Sin eso el endpoint es un oráculo de
contraseñas, y el costo de scrypt lo convierte además en un vector de agotamiento
de CPU.

`middleware.ts` es una **guarda de UX, no el límite de seguridad**: corre en Edge
y no puede consultar Postgres, así que solo mira si la cookie está presente.
Quien autoriza de verdad son las rutas y las páginas, que resuelven la sesión
contra la base en cada request. Para rutas `/api/*` el middleware devuelve 401
JSON en vez de redirigir, para que un cliente de API nunca reciba HTML.

### Altas de usuarios

El camino previsto es la CLI, no un endpoint público:

```bash
npm run user:create -- alice@example.com --name "Alice"
npm run user:create -- alice@example.com --password 'elegida'
npm run user:create -- alice@example.com --reset      # nueva contraseña
```

Sin `--password` genera una fuerte y la imprime una sola vez. Un `--reset`
cierra todas las sesiones de ese usuario.

`POST /api/auth/register` existe pero está **apagado**: responde 403 salvo que
pongas `ALLOW_REGISTRATION=true`. Con el flag activo valida formato de email,
exige fuerza mínima y limita a 5 altas por hora por IP.

`POST /api/auth/password` cambia la contraseña con la actual como prueba, y
**invalida todas las sesiones incluida la que la pidió** — un cambio de
contraseña es la respuesta estándar a una sospecha de compromiso, así que dejar
las otras vivas anularía el sentido.

### Rotación de CREDENTIALS_KEY

`CREDENTIALS_KEYS_OLD` acepta claves retiradas separadas por coma, usadas **solo
para descifrar**. Como AES-GCM autentica, probar varias es seguro: una clave
incorrecta falla limpio en vez de devolver basura. No hay cambio de formato ni
ventana de migración:

1. Generá una clave nueva.
2. Mové el valor actual de `CREDENTIALS_KEY` a `CREDENTIALS_KEYS_OLD`.
3. Poné la nueva en `CREDENTIALS_KEY`.
4. Reiniciá app y worker — todo sigue abriéndose por el respaldo.
5. `npm run keys:rotate` (probá antes con `-- --dry-run`).
6. Borrá `CREDENTIALS_KEYS_OLD` y reiniciá.

El script es idempotente y **nunca toca una fila que no pudo abrir**: reporta
cuáles fallaron y sale con código 1, porque perder el dato es peor que un
reintento con la clave correcta.

> Si te salteás el paso 2, las credenciales existentes quedan ilegibles y las
> cuentas tienen que volver a autenticarse. Hay un test que cubre exactamente
> ese error.

## Tests

```bash
npm run smoke              # 9 tests: cripto, validación, errores — sin infra
npm run test:setup         # crea redroid_test y le aplica las migraciones
npm run test:integration   # 70 tests contra Postgres y Redis reales
npm test                   # ambos
```

Los tests de integración usan `.env.test`: base `redroid_test` y **la DB 1 de
Redis**, porque la suite trunca tablas y hace `flushdb`. `tests/helpers/harness.ts`
se niega a arrancar si `DATABASE_URL` no termina en `_test` o si Redis apunta a la
db 0 — un `flushdb` contra la db de desarrollo se lleva la cola entera.

Corren en serie (`--test-concurrency=1`) porque comparten esa base: en paralelo el
`reset()` de un archivo trunca las tablas mientras otro está a mitad de un test.

Cubren los caminos que importan: idempotencia (secuencial y concurrente),
reintentos con backoff, errores permanentes que no se reintentan, agotamiento
hacia la DLQ, recuperación de huérfanos, rate limit por cuenta sin consumir
intentos, aislamiento entre usuarios, y el pipeline de media con archivos reales.
`RETRY_BACKOFF_MS` y `RATE_LIMIT_DEFER_MS` se comprimen en `.env.test` para que
ejercitar el presupuesto de reintentos tarde menos de un segundo en vez de cinco
minutos.
