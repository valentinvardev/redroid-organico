# redroid-organico

Cola de publicación asíncrona: Next.js + Prisma/PostgreSQL + BullMQ/Redis, con
pipeline de media, reintentos idempotentes, observabilidad por job y dashboard en
vivo.

## Estado

Implementado: las ocho fases M0–M7 del roadmap, autenticación con sesiones,
gestión de usuarios, rotación de claves de cifrado, y 110 tests (101 de
integración contra Postgres y Redis reales, 9 sin infraestructura).

**El driver `android` todavía no corrió contra un dispositivo real.** Su lógica
está cubierta por tests que hablan HTTP real contra un servidor Appium simulado
—incluida la garantía de que un flujo que no encuentra sus elementos falla en vez
de reportar éxito— pero nunca manejó un emulador ni un contenedor ReDroid de
verdad. Ver [Publicación real](#publicación-real).

### Qué está verificado y qué no

Ejecutado y comprobado contra infraestructura real:

- Ciclo completo de publicación: upload → validación con ffprobe → thumbnail →
  encolado → worker → publicación (con el stub) → logs
- Idempotencia, reintentos con backoff, agotamiento hacia la DLQ, recuperación de
  huérfanos tras caída del worker, rate limit por cuenta
- Flujo de autenticación completo: 401 sin sesión, 429 al noveno login fallido,
  cambio de contraseña con invalidación de sesiones
- Rotación de claves con re-sellado
- **El stack completo en contenedores.** `docker compose up --build` levanta
  Postgres, Redis, aplica migraciones y arranca web y worker; el healthcheck de
  `web` pasa y un ciclo de publicación corre de punta a punta dentro de la imagen,
  con su propio ffmpeg.
- **El workflow de CI**, verde en GitHub Actions.

Lo único sin verificar es el **despliegue con HTTPS**. La cookie se marca `secure`
sola con `NODE_ENV=production`, pero eso requiere TLS delante y nunca se desplegó
en ningún lado.

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
docker compose --profile app up --build
```

Levanta Postgres, Redis, corre las migraciones y arranca web y worker. Web y
worker comparten el volumen `media` porque con `STORAGE_DRIVER=local` el worker
lee los archivos que escribió la web; con `s3` ese acoplamiento desaparece.

El perfil `app` existe para que un `docker compose up` pelado no pueda levantar
una segunda copia de la aplicación. **Web y worker van en containers o en el
host, nunca mezclados**: dentro del contenedor `STORAGE_LOCAL_DIR` resuelve a
`/app/.storage` y no ve los archivos que escribió un panel corriendo en el host,
así que con dos workers repartiéndose la misma cola el resultado de un job
depende de cuál lo haya tomado.

Para correrlos en el host con systemd, ver [deploy/](deploy/).

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
| `npm run account:list` | Cuentas con su configuración descifrada, redactada |
| `npm run account:export` | Las credenciales de una cuenta como JSON reimportable |
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
| `lib/proxy/` | Validación de proxies, armado de la URL, asignación por cuenta |
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

El adaptador previsto es la **API oficial de publicación de contenido de la app objetivo**,
con tokens OAuth por cuenta guardados en `Account.credentials`. Implementar
`Publisher`, registrarlo y ampliar `PUBLISHER_DRIVER` en `lib/env.ts` es todo lo
que hace falta; nada aguas arriba cambia.

`PUBLISHER_DRIVER` acepta `stub`, `noop`, `tiktok` y `android`. `stub` ejerce el
flujo completo, validando los medios en disco antes de devolver un id sintético.
`noop` es útil para demos y pruebas secas porque acepta la solicitud sin
necesitar un archivo real en disco. `tiktok` usa credenciales OAuth cifradas en
`Account.credentials`. `android` es el adaptador central del proyecto: maneja la
app bajo prueba en un dispositivo Android real o containerizado, vía ADB +
Appium.

### El driver `android`

Cada cuenta declara **qué app manejar y con qué pasos**, en
`Account.credentials`. No hay defaults de plataforma: una cuenta sin
`packageName` o sin `flow` es rechazada al crearse, no al ejecutarse.

El flujo es una lista de pasos declarativos (`lib/android/uiFlow.ts`):

| Acción | Qué hace |
| --- | --- |
| `tap` | Espera el elemento y lo toca |
| `type` | Espera, limpia y escribe (soporta `{{caption}}`) |
| `assertVisible` | Exige que el elemento aparezca; con `captureText` su texto pasa a ser el `externalPostId` |
| `assertGone` | Exige que el elemento desaparezca — un spinner que termina |
| `wait` | Pausa fija |

Dos reglas hacen que un run no pueda mentir:

1. **Un flujo sin ninguna aserción es rechazado.** Un test que solo toca botones
   siempre puede reportar éxito, que es peor que no tener test.
2. **Un paso que no encuentra su elemento falla el job.** La tolerancia es
   opt-in con `"optional": true`, pensada para diálogos condicionales
   (permisos, "calificanos"), y cada salto queda registrado en los logs del job.

El `externalPostId` sale del elemento que confirma la subida, o es
`android_<jobId>` — nunca un UUID al azar, porque un id inventado antes de tocar
la UI es indistinguible de una publicación real.

Cuando un paso falla se guardan **screenshot y jerarquía UI** en el storage
(`artifacts/<jobId>/…`, local o S3) y sus claves quedan en el log del job.

Clasificación de errores, que es lo que decide si BullMQ reintenta:

| Situación | Código | ¿Reintenta? |
| --- | --- | --- |
| Dispositivo sin bootear | `device_not_ready` | Sí |
| Push incompleto | `media_push_truncated` | Sí |
| Appium inalcanzable | `appium_unreachable` | Sí |
| Selector que nunca aparece | `ui_step_not_found` | **No** |
| App caída tras el launch | `app_not_running` | **No** |
| Credenciales/flujo inválidos | `invalid_android_credentials` | **No** |
| Cuenta con proxy sobre un dispositivo `attached` | `proxy_requires_ephemeral_device` | **No** |
| El dispositivo sale por la IP del host | `egress_leak_detected` | **No** |
| Ni el dispositivo ni el gateway alcanzan la red | `egress_unreachable` | Sí |

Reintentar un selector equivocado tres veces gasta cinco minutos, informa lo
mismo, y esconde un defecto real de la app detrás de "intento 3/3".

### Dónde corre el Android

El driver no sabe de dónde sale el dispositivo. Eso lo decide un *provider*
(`lib/android/deviceProvider.ts`), elegido según la cuenta:

- **`attached`** — el dispositivo ya existe y sobrevive al job: un AVD local, un
  teléfono por USB, un contenedor que administra otro. Es el default. Liberar no
  hace nada: destruir un dispositivo que este sistema no creó sería una sorpresa,
  no una limpieza.
- **`redroid`** — se activa poniendo un bloque `redroid` en las credenciales de
  la cuenta. Crea un contenedor Android descartable por job y lo destruye al
  terminar.

#### Ciclo de vida del contenedor efímero

```
acquire()
  ├─ rechaza si la cuenta ya tiene un contenedor vivo   (dos jobs = un volumen = corrupción)
  ├─ docker volume create redroid-session-<accountId>   (sesión persistente por cuenta)
  ├─ docker run --privileged --label ...                (etiquetado para el reaper)
  ├─ espera el puerto ADB publicado                     (Docker elige uno libre)
  ├─ adb connect  ──► reintenta hasta startTimeoutSeconds
  ├─ espera sys.boot_completed=1 Y init.svc.bootanim=stopped
  └─ verifica que el paquete esté instalado
release()
  ├─ adb disconnect   (si no, el server acumula entradas "offline")
  └─ docker rm -f
```

Las tres compuertas de readiness importan porque cada una pasa mientras la
siguiente falla. ReDroid marca `sys.boot_completed` mientras la animación de
arranque sigue corriendo y el package manager todavía se está acomodando:
entregarle ese dispositivo a Appium produce runs que fallan con "elemento no
encontrado" sin que el flujo tenga nada malo.

El volumen de sesión es **por cuenta**, montado en `/data`, que es donde Android
guarda todo lo que debe sobrevivir entre runs: el login, las bases de la app, las
preferencias. Dos cuentas nunca se ven el estado.

#### Que no queden zombies

Un contenedor Android sobrevive al proceso que lo creó y se come un giga de RAM,
así que hay tres mecanismos independientes — cualquiera de ellos se puede saltear:

1. **`release()` en el `finally` del publisher.** El camino normal. Corre aunque
   Appium explote en la mitad del flujo, y aunque `acquire()` falle a mitad de
   camino, porque en ese caso el provider se limpia solo antes de propagar.
2. **Timeout en cada llamada a `docker`.** Un daemon trabado no puede convertir
   "destruí el contenedor" en una promesa que nunca resuelve.
3. **El reaper** (`lib/android/reaper.ts`). Lo único que sirve cuando el worker
   recibe SIGKILL y ningún `finally` llega a correr.

El reaper decide contra **la base de datos**, no contra estado en memoria: un
contenedor cuya etiqueta `jobId` apunta a un job que no está `PROCESSING` es
basura, sin importar qué worker lo creó. Eso lo hace correcto con varias réplicas.
Compone con `recoverOrphans()`, que corre antes en el arranque y saca de
`PROCESSING` los jobs que dejó colgados un worker muerto — justo lo que vuelve
reconocibles a sus contenedores.

Ante la duda, no mata: un contenedor más joven que el período de gracia se deja
en paz, y si no puede consultar el job lo reporta y sigue. Filtrar de más es peor
que filtrar de menos cuando la alternativa es matar un run sano.

#### Topología en compose

```bash
docker compose --profile android up --build
```

Levanta, además del stack normal, un **servidor adb compartido** y **Appium**.
Lo compartido no es un detalle: si cada lado corriera su propio adb, un
dispositivo conectado por el worker sería invisible para Appium. Appium apunta al
mismo servidor vía `ANDROID_ADB_SERVER_HOST`.

Los contenedores ReDroid **no** están declarados en el compose: los crea el
worker por job, en la red `redroid-net`. Por eso la cuenta debería usar
`"connectVia": "container-name"` en ese despliegue.

El worker monta `/var/run/docker.sock`, lo que equivale a root en el host.
Aceptable para el MVP, no para un entorno compartido.

Ejemplo de bloque `redroid` en las credenciales de la cuenta:

```json
{
  "image": "sportreels/redroid:13-golden",
  "connectVia": "container-name",
  "network": "redroid-net",
  "memoryLimit": "4g",
  "gpuMode": "guest",
  "startTimeoutSeconds": 180
}
```

La imagen es tuya: ReDroid con `com.sportreels.app` ya instalado. Tiene que
coincidir con la arquitectura del host — una imagen arm64 en un host x86 no
arranca, o va a paso de qemu.

#### Salida por proxy

Cada cuenta puede tener un proxy asignado desde el dashboard (HTTP o SOCKS5, con
usuario y contraseña opcionales). No se configura **nada** dentro de Android: el
worker levanta un contenedor `tun2socks` por job y arranca el ReDroid dentro de
**su** namespace de red.

```
docker run --cap-add NET_ADMIN --device /dev/net/tun \
           --network redroid-net -p 127.0.0.1::5555 \
           -e PROXY=socks5://user:pass@gate:1080 \
           --name redroid-gw-<jobId>  xjasonlyu/tun2socks:v2.5.1

docker run --privileged --network container:redroid-gw-<jobId> \
           --name redroid-job-<jobId>  <imagen golden>
```

Por qué así y no un proxy configurado en el sistema Android: el dispositivo no
tiene ninguna interfaz propia. No hay setting que una app pueda ignorar, ni
tráfico UDP que se escape del proxy del sistema, ni estado que se pierda cuando
se restaura la sesión desde el volumen. La única salida es el `tun0` del gateway.

Consecuencias que conviene tener presentes:

- **Los puertos son del gateway.** Un contenedor que comparte namespace no puede
  publicar nada, así que el 5555 de ADB se publica en el gateway y el serial del
  dispositivo sale de ahí (`redroid-gw-<jobId>:5555` con `connectVia:
  "container-name"`).
- **Falla cerrado.** Si el proxy no responde, los paquetes mueren en el tun; no
  hay fallback a la IP del host. Un job que no puede usar su proxy falla, que es
  exactamente para lo que se asigna un proxy.
- **El orden del teardown importa.** Docker no deja borrar un contenedor mientras
  otro le presta el namespace: primero el dispositivo, después el gateway. El
  reaper barre en ese orden por la etiqueta `redroid-organico.role`.
- **HTTP relaya solo TCP, y en la práctica ni eso.** Lo que el teléfono mande por
  UDP —DNS incluido— no tiene por dónde salir, y muchos proxies HTTP resetean
  cualquier CONNECT que no vaya al 443. Si el proveedor ofrece las dos sobre el
  mismo endpoint, SOCKS5 siempre (`npm run gateway:test -- --proxy <label> --as
  socks5` lo prueba sin tocar la fila).
- **Una cuenta con proxy exige contenedor efímero.** Sobre un dispositivo
  `attached` no hay namespace que apropiarse, así que el job falla con
  `proxy_requires_ephemeral_device` en vez de publicar desde la IP del host.

La contraseña se guarda cifrada con la misma `CREDENTIALS_KEY` que el resto de
las credenciales, nunca vuelve por la API y en los logs aparece redactada
(`socks5://user:***@gate:1080`). El bloque `proxyGateway` de las credenciales
—imagen, `logLevel`, `env` extra— sólo describe cómo se construye el gateway; el
proxy en sí vive en la base.

#### La URL del visor no lleva una IP

`DEVICE_VIEWER_URL_TEMPLATE` acepta `{host}` además de `{serial}` y
`{serialDouble}`, y **conviene usarlo**: la URL la arma el worker, que no tiene
request que mirar y por lo tanto no puede saber por qué dirección entró el
operador al panel. Una plantilla con un host literal anda solo desde donde
estabas cuando la configuraste.

```
DEVICE_VIEWER_URL_TEMPLATE="http://{host}:8000/#!action=stream&udid={serial}&player=broadway&ws=ws%3A%2F%2F{host}%3A8000%2F%3Faction%3Dproxy-adb%26remote%3Dtcp%253A8886%26udid%3D{serialDouble}"
```

El navegador reemplaza `{host}` por la dirección desde la que cargó la página,
así que el mismo valor sirve por túnel SSH, por IP pública o por dominio — y
sobrevive a que la máquina cambie de dirección, que es el caso que rompe el
visor sin romper nada más: el iframe apunta a un host que en el navegador
significa otra cosa, y queda en blanco mientras el resto del panel funciona.

Endpoints, todos bajo la sesión del usuario dueño de la cuenta:

| Ruta | Qué hace |
| --- | --- |
| `GET /api/proxies` | Lista los proxies del usuario, con cuántas cuentas usa cada uno |
| `POST /api/proxies` | Alta, validando formato antes de guardar |
| `PATCH /api/proxies/:id` | Edición parcial; sin `password` deja la guardada |
| `DELETE /api/proxies/:id` | 409 si alguna cuenta todavía lo usa |
| `PUT /api/accounts/:id/proxy` | Asigna (`{"proxyId": "..."}`) o desasigna (`null`) |

El cambio aplica al **próximo** job: un teléfono que ya está corriendo se queda
con el gateway con el que arrancó, porque mover un contenedor vivo a otro
namespace de red no es algo que Docker sepa hacer.

#### Por qué compartir el namespace no alcanza

Meter al ReDroid en el namespace del gateway es necesario pero **no suficiente**:
`netd` no es un inquilino pasivo de ese namespace. Instala sus propias reglas de
policy routing y le estampa a cada socket el netId con `SO_MARK`, así que el
tráfico de Android matchea *sus* reglas y sale por eth0 mientras un `curl` sin
marca, en el mismo namespace, sigue obedientemente el tun. Nada se escapa del
namespace —no puede—: netd simplemente gana por prioridad, porque todo lo que
instala vive en la banda 10000–32000 y el catch-all del gateway queda por encima.

El diagnóstico, en dos comandos:

```bash
GW=redroid-gw-<jobId>
docker exec $GW ip route get 1.1.1.1            # sin marca: lo que hace curl
docker exec $GW ip route get 1.1.1.1 mark 100   # con netId: lo que hace Android
```

Si la primera dice `dev tun0` y la segunda `dev eth0`, es esto.

La respuesta son tres capas, en `lib/android/egressPolicy.ts`, aplicadas por
`docker exec` **después** de `sys.boot_completed` —netd inserta sus jumps al tope
de las cadenas mientras arranca, así que lo que se escriba antes queda detrás:

1. **Ruteo.** Las mismas reglas en `pref 90` (bypass del socket propio de
   tun2socks) y `pref 100` (todo lo demás al tun), por debajo de todo lo de netd.
2. **Marcado.** `mangle OUTPUT` borra la marca de netd, lo que además obliga al
   kernel a rehacer el lookup de ruta para ese paquete.
3. **ACL.** Decida lo que decida el ruteo, solo pueden emitir: `lo`, el `tun0`,
   las respuestas a conexiones entrantes (ADB), el socket marcado del gateway y
   la subred de control. El resto, `REJECT`. Un leak deja de ser una IP
   equivocada y pasa a ser una conexión que falla.

La red de control existe para que esa única excepción no sea un agujero:
`redroid-control-net` está declarada `internal: true`, o sea que Docker no le da
ruta fuera del host. La restricción vive **afuera** del namespace, donde Android
no la puede tocar ni siendo privilegiado.

Y como nada de lo anterior es evidencia, cada job con proxy termina la
adquisición preguntándole al dispositivo por su propia IP y comparándola con la
del host:

```
[info] Egress verified from inside the device  deviceIp=203.0.113.7 directIp=190.x.x.x
```

Si coinciden, el job falla con `egress_leak_detected` (permanente: reintentar
sería otra chance de publicar desde la IP equivocada) y el contenedor se destruye
antes de que el flujo toque la app. La comparación es contra la IP **directa**,
no contra la del proxy, porque un residencial rotativo entrega un exit distinto
por conexión y compararlo contra el proxy daría falsos positivos todo el día.

El check necesita un cliente HTTP en el dispositivo, y **una imagen AOSP no trae
ninguno**: ni curl, ni un toybox con el applet `wget`. Apuntá `probeBinary` a un
curl estático para la arquitectura del device y el worker lo copia solo, una vez
por cuenta:

```json
"egressCheck": { "probeBinary": "/srv/redroid/curl-aarch64" }
```

Va a `/data/local/tmp`, que es el volumen de sesión de la cuenta: se copia en el
primer run y persiste, igual que el APK y por el mismo motivo. `/system` haría
falta `adb remount`, que una imagen con verity rechaza. Binarios estáticos en
https://github.com/moparisthebest/static-curl.

```bash
./scripts/build-golden-image.sh --apk app.apk --tag mi/redroid:golden \
  --tool ./bin/curl-arm64-static
```

Ajustes, todos en el bloque `proxyGateway` de las credenciales:

| Clave | Default | Para qué |
| --- | --- | --- |
| `harden` | `true` | Aplicar las tres capas. Apagarlo es solo para depurar |
| `disableIpv6` | `true` | La imagen no trae `ip6tables`: una ruta v6 sería una salida que el ACL no ve |
| `egressCheck.enabled` | `true` | El gate de verificación |
| `egressCheck.url` | `http://api.ipify.org` | El worker lo resuelve y se lo pasa a `curl --resolve`, así el dispositivo nunca hace DNS. No uses una IP de resolver público (1.1.1.1): los residenciales las bloquean. Sirve cualquier endpoint que devuelva una IP pelada o un cuerpo con una línea `ip=` |

#### Preparar el host (esto no es opcional)

Verificado en Ubuntu 26.04 LTS, kernel 7.0.0-aws, Graviton arm64.

**binderfs.** Los kernels modernos traen `CONFIG_ANDROID_BINDER_DEVICES=""`, así
que no existe `/dev/binder` y el viejo
`modprobe binder_linux devices="binder,hwbinder,vndbinder"` no crea nada. Los
devices viven en binderfs:

```bash
sudo modprobe binder_linux
sudo mkdir -p /dev/binderfs
sudo mount -t binder binder /dev/binderfs
ls /dev/binderfs        # binder, binder-control, hwbinder, vndbinder

# Que sobreviva reboots:
echo 'binder /dev/binderfs binder nofail 0 0' | sudo tee -a /etc/fstab
```

El provider monta ese path dentro del contenedor. Se configura con
`binderfsPath` (default `/dev/binderfs`, `null` para deshabilitarlo en un host
que sí exponga `/dev/binder`).

**/dev/net/tun.** Sólo hace falta si vas a usar proxies: el gateway crea su tun
device desde adentro del contenedor y sin ese device no arranca.

```bash
sudo modprobe tun
ls -l /dev/net/tun                                   # querés que exista
echo tun | sudo tee /etc/modules-load.d/redroid.conf # que sobreviva reboots
```

**Los módulos legacy de netfilter, en cambio, no los cargues.** La imagen del
gateway apunta `iptables` al binario *legacy*, y en un host con nftables
—Ubuntu 24.04 en adelante— eso contesta `Table does not exist` para `mangle`,
después para `filter`, y no se termina más. Perseguirlo con
`modprobe iptable_mangle`, `xt_mark`, `iptable_filter` es emular a mano, de a un
módulo por vez, un backend que el kernel ya tiene.

El script elige el backend que el kernel conteste —`iptables-nft` primero,
`iptables-legacy` después— y deja constancia en el log del job:

```
[debug] INFO: iptables backend: iptables-nft
```

Si ninguno anda, la adquisición falla en vez de seguir: sin firewall el
dispositivo correría sin filtro, que es justo lo que esto viene a evitar. Y si
el backend anda pero le falta alguna pieza (la tabla `mangle`, el match `mark`,
`conntrack`), esa regla se saltea con un `WARN` y el resto queda igual: lo que
sostiene la garantía no depende de ningún módulo — la ruta al tun, el `REJECT`
final, la salida del gateway hacia su proxy (abierta por destino, no por marca)
y las respuestas de ADB (por `--sport 5555`, sin estado).

Para confirmar que el kernel sirve:

```bash
grep -iE 'BINDER|ASHMEM' /boot/config-$(uname -r)
grep -i binder /proc/filesystems     # necesitás "nodev binder"
```

**memfd, no ashmem.** Si el grep de arriba no muestra ninguna línea de `ASHMEM`,
el kernel no lo tiene — y **ReDroid 11 no arranca sin ashmem**. Hay que usar
imagen 12 o 13, que caen a memfd, y pedírselo explícitamente. El provider pasa
`androidboot.use_memfd=1` por defecto (`useMemfd: false` para desactivarlo). Sin
eso el contenedor arranca y se cuelga a mitad del boot sin error visible, que es
la peor forma de fallar.

**Probar a mano antes de enchufar el worker.** Cuando algo no bootea, esto aísla
el problema en un minuto:

```bash
docker run -itd --privileged --name redroid-smoke \
  -v /dev/binderfs:/dev/binderfs -p 127.0.0.1:5599:5555 \
  redroid/redroid:13.0.0-latest \
  androidboot.redroid_gpu_mode=guest androidboot.use_memfd=1

adb connect localhost:5599
adb -s localhost:5599 shell getprop sys.boot_completed   # querés 1
adb -s localhost:5599 shell getprop init.svc.bootanim    # querés stopped
adb -s localhost:5599 shell getprop ro.product.cpu.abi   # arm64-v8a en Graviton

docker rm -f redroid-smoke
```

Esos dos primeros properties son exactamente las compuertas que chequea
`AdbDevice.waitUntilReady()`.

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

### Agregar cuentas de app

El CLI de cuentas ahora soporta dos modos:

- `--driver api` para credenciales OAuth/API
- `--driver android` para credenciales ADB/Appium

Ejemplos:

```bash
npm run account:add -- --user <userId> --name "API Credentials" --driver api \
  --access-token "<token>" --refresh-token "<refresh-token>" --expires-at "2026-12-31T00:00:00Z"
```

```bash
npm run account:add -- --user <userId> --name "App bajo prueba" --driver android \
  --appium-url "http://127.0.0.1:4723" \
  --package-name "com.example.app" \
  --flow examples/flows/upload-video.json \
  --device-serial "emulator-5554" \
  --remote-video-path "/sdcard/DCIM/upload.mp4"
```

`--flow` es obligatorio y se valida contra el mismo esquema que usa el worker,
así que un flujo mal formado — sin aserciones, con una estrategia de locator
inexistente — se rechaza al crear la cuenta. `--activity-name` es opcional: sin
él, Android resuelve la activity de lanzamiento, lo que sobrevive a que la app
renombre su entry point entre builds.

`examples/flows/upload-video.json` es una plantilla para copiar y adaptar a los
`resource-id` de tu app.

La cuenta se guarda en `Account.credentials` cifrada y el worker la descifra solo
cuando ejecuta el job.

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
npm run test:integration   # 101 tests contra Postgres y Redis reales
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
